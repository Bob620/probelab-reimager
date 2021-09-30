const fs = require('fs');
const path = require('path');

const generateUuid = require('./generateuuid.js');
const Position = require('./position.js');

const iconv = require('./external/win1251.js'); //iconv-lite generated win1251 ONLY (v0.7.0-pre / Mar 27, 2021)
let Adodb;

// Load adodb in windows environments, otherwise load mdb-sql
// If both fail to load, use a mock-up that will return nothing
try {
	Adodb = require('database-js-adodb');
} catch (err) {
	try {
		Adodb = require('node-mdb-sql');
	} catch (e) {
		console.log('Unable to load adodb or mdb-sql');
		Adodb = {
			open: () => ({
				query: () => [],
				close: () => {
				}
			})
		};
	}
}

const constants = require('./constants.json');

function convertRawThermoToPositionType(rawType) {
	switch(rawType.toLowerCase()) {
		case 'spot':
		default:
			return constants.position.types.SPOT;
		case 'circle':
			return constants.position.types.CIRCLE;
		case 'polygon':
			return constants.position.types.POLYGON;
		case 'rect':
			return constants.position.types.RECTANGLE;
	}
}

function readMASFile(uri) {
	let rawData = fs.readFileSync(uri, {encoding: 'utf8'}).split('#');

	return rawData.filter(data => data).reduce((output, line) => {
		const [rawName, data] = line.split(':');
		const [name, units] = rawName.toLowerCase().trim().split('-');
		const normalizedName = name.trim();

		if (name && data && name !== 'spectrum' && name !== 'endofdata')
			if (output[normalizedName] === undefined)
				output[normalizedName] = {
					units: units ? units.trim() : '',
					data: data.trim()
				};
			else {
				if (typeof output[normalizedName].data === 'string')
					output[normalizedName].data = [output[normalizedName].data];

				output[normalizedName].data.push(data.trim());
			}

		return output;
	}, {});
}

function readNSSEntry(uri, imageUuid = generateUuid.v4()) {
	if (uri.endsWith('.map'))
		return readNSSMapEntry(uri, imageUuid);

	let rawData = fs.readFileSync(uri, {encoding: 'utf8'}).replace(/�/gi, '\u00a0').split('#').map(text => {
		const data = text.split('\r\n');
		if (data.length === 1)
			return text.split('\n');
		else
			return data;
	});

	let output = {
		imageUuid,
		points: [],
		layers: [],
		data: {
			spectra: '',
			base: '',
			grey: '',
			raw: ''
		}
	};

	// csi
	// p_s
	// lsctl
	// map
	// grid
	// tnp
	// fss

	// Types
	//   LS - Linescan
	//     REF - (tif)
	//     MSA - (EMSA)
	//   FZ - XPhase
	//     M - (tif)
	//     MA - Map Analysis? (tif)
	//     ME - (tif)
	//     S - (ESMA)
	//     SA - spectrum analysis? (EMSA)
	//     SE - (EMSA)
	//   PC - Compass
	//     M - (tif)
	//     MA - Map Analysis? (tif)
	//     ME - (tif)
	//     S - (EMSA)
	//     SA - (EMSA)
	//     SE - (EMSA)
	//   SI - Spectral Imaging
	//     SITIF - (tif)
	//     REF - (tif)
	//     MSA - (EMSA)
	//     MCS - (?)
	//   PS - Point ID
	//     REF - (tif)
	//     MSA - (EMSA)

	// Files
	//   EMSA - EMSA for map data (EMSA)
	//   CSI  - directory index for maps
	//   P_S  - directory index for PS
	//   EM   - Element Map (tif)

	for (const line of rawData.shift())
		if (line.length > 1 && line.includes('.')) {
			const extension = path.extname(line).toLowerCase().slice(1);
			if (extension.length > 2) {
				// Identify typed files
				const type = extension.slice(0, 2);
				const format = extension.slice(2);
				let name;

				switch(format) {
					case 'm':
					case 'ma':
					case 'me':
						name = line.toLowerCase().split(' ');
						output.layers.push({
							element: `${name.pop().split('.')[0]} ${name.pop()}`,
							file: line
						});
						break;
					case 's':
					case 'sa':
					case 'se':
						break;
					case 'ref':
						output.data.base = line;
						break;
					case 'tif':
						output.data.grey = line;
						break;
					case 'mcs':
						name = line.toLowerCase().split(' ');
						output.layers.push({
							element: `${name.pop().split('.')[0]} ${name.pop()}`,
							file: line
						});
						break;
				}
			} else {
				// Generic files
				if (extension === 'si')
					output.data.raw = line;
			}
		}

	for (const element of rawData) {
		let type = element.shift().split(' ')[1].toLowerCase().trim();
		if (type !== 'imgint')
			output.points.push(
				new Position.Thermo(element.shift(), 0, convertRawThermoToPositionType(type),
					element.map(line => line.length > 1 ? line.split(',').filter(x => x !== undefined && x.length > 0).map(num => parseInt(num)) : []).flat(),
					{
						orientation: {
							x: constants.stageOrientation.direction.UNKNOWN,
							y: constants.stageOrientation.direction.UNKNOWN
						}
					},
					{
						uuid: imageUuid,
						software: constants.software.id.THERMO
					}
				));
	}

	return output;
}

function readNSSMapEntry(uri, imageUuid = generateUuid.v4()) {
	const inputData = readMASFile(uri);

	let output = {
		imageUuid,
		points: [],
		layers: [],
		data: {
			spectra: '',
			base: inputData.refimg.data,
			grey: inputData.mapimg.data.shift(),
			raw: ''
		},
		name: inputData.title.data
	};

	output.layers = inputData.mapimg.data.map(name => {
		return {
			element: `${name.split('.')[0]} ${name}`,
			file: name
		};
	});

	return output;
}

async function readPFEEntry(databaseUri, attempt = 0) {
	const uri = databaseUri.split('?')[0];

	let connection;

	try {
		// Try for the connection with a 1s retry in case it is locked for some reason
		connection = await new Promise(async resolve => {
			try {
				const c = await Adodb.open({
					Database: uri
				});
				resolve(c);
			} catch (e) {
				setTimeout(async () => {
					const c = await Adodb.open({
						Database: uri
					});
					resolve(c);
				}, 1000);
			}
		});

		let images = (await connection.query(`SELECT * FROM [Image]`)).map(async image => {
			const imageUuid = generateUuid.v4();

			// Normalize all the incoming image location data
			image.ImageXMax = parseFloat(image.ImageXMax.toFixed(7));
			image.ImageXMin = parseFloat(image.ImageXMin.toFixed(7));
			image.ImageYMax = parseFloat(image.ImageYMax.toFixed(7));
			image.ImageYMin = parseFloat(image.ImageYMin.toFixed(7));

			image.ImageZ1 = parseFloat(image.ImageZ1.toFixed(7));
			image.ImageZ2 = parseFloat(image.ImageZ2.toFixed(7));
			image.ImageZ3 = parseFloat(image.ImageZ3.toFixed(7));
			image.ImageZ4 = parseFloat(image.ImageZ4.toFixed(7));

			// Default to anti-cartesian (JEOL)
			let yDirection = constants.stageOrientation.direction.OBVERSE;
			let xDirection = constants.stageOrientation.direction.OBVERSE;
			let xSmall = image.ImageXMin;
			let xLarge = image.ImageXMax;
			let ySmall = image.ImageYMin;
			let yLarge = image.ImageYMax;

			// Make sure we have the correct orientation
			if (image.ImageXMin > image.ImageXMax) {
				xSmall = image.ImageXMax;
				xLarge = image.ImageXMin;
				xDirection = constants.stageOrientation.direction.REVERSE;
			}

			if (image.ImageYMin > image.ImageYMax) {
				ySmall = image.ImageYMax;
				yLarge = image.ImageYMin;
				yDirection = constants.stageOrientation.direction.REVERSE;
			}

			// Image size in measurable distance
			image.xDiff = parseFloat(Math.abs(xLarge - xSmall).toFixed(7));
			image.yDiff = parseFloat(Math.abs(yLarge - ySmall).toFixed(7));
			// X-based pixel size
			// May cause slight (1-2 pixel) point shift but not noticeable on images larger than 128px
			image.pixelSizeX = parseFloat(((image.xDiff * 1000) / image.ImageIx).toFixed(10));
			image.pixelSizeY = parseFloat(((image.yDiff * 1000) / image.ImageIy).toFixed(10));
			image.centerX = image.ImageXMin + (image.xDiff / 2);
			image.centerY = image.ImageYMin + (image.yDiff / 2);
			image.xDirection = xDirection;
			image.yDirection = yDirection;

			const initialPoints = await connection.query(`SELECT * FROM [Line] WHERE ${xSmall} <= StageX AND ${xLarge} >= StageX AND ${ySmall} <= StageY AND ${yLarge} >= StageY`);
			const analysisData = (await connection.query('SELECT * FROM [Element]')).reduce((analysis, analysisData) => {
				analysisData[analysis.ElementToRow] = analysis
				return analysisData
			}, {});

			// Calculate in um
			const points = initialPoints
			.map(({Number, StageX, StageY, LineToRow, DateTime}) => {
				return (new Position.PFE(`${Number}`, LineToRow, constants.position.types.SPOT, [StageX * 1000, StageY * 1000], {
					orientation: {
						x: xDirection,
						y: yDirection
					}
				}, {
					uuid: imageUuid,
					software: constants.software.id.PFE
				})).extraData({
					beamdiam: {data: analysisData.BeamSizeArray},
					beamkv: {data: analysisData.KilovoltsArray},
//					beamx: {data: 0},
//					beamy: {data: 0},
					magcam: {data: 0},
					date: {
						data: DateTime
					},
					probecur: {data: analysisData.BeamCurrentArray}
				});
			});

			return {image, points, uuid: imageUuid};
		});

		images = await Promise.all(images);
		await connection.close();

		return images;
	} catch (err) {
		if (connection)
			await connection.close();

		// Failed due to bad password?
		// Bad Password ---  -2147217843
		// Bad State    ---  -2147467259
		if ((err.process.code === -2147217843 || err.process.code === -2147467259) && attempt < 50)
			return await readPFEEntry(databaseUri, attempt + 1);

		throw new Error('Unable to open and read PFE mdb file');
	}
}

async function readBIM(bimUri) {
	let [uri, index = '1'] = bimUri.split('?');
	index = parseInt(index);

	const data = Buffer.from(await fs.promises.readFile(uri.slice(0, uri.length - constants.pfe.fileFormats.ENTRY.length) + constants.pfe.fileFormats.IMAGE, {encoding: null}));
	const maxLength = data.byteLength;
	let offset = 0;
	let fileIndex = 1;

	while (offset < maxLength) {
		const width = data.readUInt32LE(offset);
		const height = data.readUInt32LE(offset + 4);
		offset += 8;

		if (fileIndex === index) {
			let pixels = [];
			let max = Number.NEGATIVE_INFINITY;
			let min = Number.POSITIVE_INFINITY;

			for (let i = 0; i < width * height; i++) {
				const value = data.readInt32LE(offset + (i * 4));

				if (value > max)
					max = value;
				else if (value < min)
					min = value;

				pixels.push(value);
			}

			max = max - min;
			return Buffer.from(pixels.map(pixel => ((pixel - min) / max) * 255));
		}
		offset += width * height * 4;
		fileIndex++;
	}
}

function readJeolEntry(uri) {
	let rawData = iconv.decode(fs.readFileSync(uri), 'win1251').split('$');

	return rawData.filter(data => data).reduce((output, line) => {
		const [prop, ...data] = line.trim().toLowerCase().split(' ');
		output[prop] = data.length === 1 ? data[0] : data;

		return output;
	}, {});
}

function checkJeolExists(uri) {
	return fs.accessSync(uri, fs.constants.R_OK);
}

function checkBIMExists(uri) {
	fs.accessSync(uri, fs.constants.R_OK);

	let bim = uri.split('.');
	bim = bim.slice(0, bim.length - 1).join('.') + '.BIM';
	fs.accessSync(bim, fs.constants.R_OK);

	return true;
}

// nothing exists to do this apparently
function readBmp(uri) {
	const raw = fs.readFileSync(uri);

	if (raw[0] !== 66 || raw[1] !== 77)
		throw new Error('Unsupported bmp format');

	const data = new DataView(raw.buffer);

//	const fileSize = data.getInt32(2, true);
	const offset = data.getInt16(10, true);
	const format = data.getInt32(14, true);

	if (format !== 40)
		throw new Error('Unsupported bmp format');

	const width = data.getInt32(18, true);
	const height = data.getInt32(22, true);
	const planes = data.getInt16(26, true);
	const colorDepth = data.getInt16(28, true);
	const compressionMethod = data.getInt32(30, true);
//	const imageSize = data.getInt32(34, true);
//	const horizontalRes = data.getInt32(38, true);
//	const verticalRes = data.getInt32(42, true);
//	const colorPallet = data.getInt32(46, true);
//	const importantColors = data.getInt32(50, true);

	if (planes !== 1 || colorDepth !== 8)
		throw new Error('Unsupported bmp format');

	if (compressionMethod !== 0)
		throw new Error('Unsupported compression method');

//	const mask = data.buffer.slice(54, offset);

	let pixels = [];
	let w = 0;
	let h = height;
	for (let i = 0; i < width * height; i++, w++) {
		if (i % width - 1 === 0) {
			h--;
			w = 0;
		}

		const pixelOffset = w + (h * width - 1);
		pixels[pixelOffset] = data.getInt8(offset + i);
	}

	return {
		pixels: Buffer.from(pixels),
		height,
		width
	};
}

module.exports = {
	readBmp,
	readMASFile,
	readNSSEntry,
	readNSSMapEntry,
	readPFEEntry,
	readJeolEntry,
	readBIM,
	checkJeolExists,
	checkBIMExists
};