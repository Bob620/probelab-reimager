const Jimp = require('jimp');

const constants = require('./constants');
const io = require('./io');
const calculations = require('./calculations');

module.exports = async () => {
	const fonts = {
		white: {
			[constants.scale.sizes.TINY]: await Jimp.loadFont(Jimp.FONT_SANS_8_WHITE),
			[constants.scale.sizes.SMALL]: await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE),
			[constants.scale.sizes.NORMAL]: await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE),
			[constants.scale.sizes.LARGE]: await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE),
			[constants.scale.sizes.SUPER]: await Jimp.loadFont(Jimp.FONT_SANS_128_WHITE)
		},
		black: {
			[constants.scale.sizes.TINY]: await Jimp.loadFont(Jimp.FONT_SANS_8_BLACK),
			[constants.scale.sizes.SMALL]: await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK),
			[constants.scale.sizes.NORMAL]: await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK),
			[constants.scale.sizes.LARGE]: await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK),
			[constants.scale.sizes.SUPER]: await Jimp.loadFont(Jimp.FONT_SANS_128_BLACK)
		}
	};

	return class ExtractedMap {
		constructor(entryFile, uri=undefined) {
			const directoryName = entryFile.uri.split('/').slice(-2, -1)[0];

			this.data = {
				uri: uri ? uri : entryFile.uri.split('/').slice(0, -1).join('/') + '/',
				name: directoryName.substring(0, directoryName.length - constants.extractedMap.fileFormats.DIRECTORYCONST.length),
				image: undefined,
				magnification: 1,
				files: {
					image: '',
					entry: entryFile.uri
				}
			};

			this.data.files.image = this.data.uri + this.data.name + constants.extractedMap.fileFormats.IMAGERAW;

			this.updateFromDisk();
		}

		updateFromDisk() {
			this.data.data = io.readMASFile(this.data.files.entry);

			this.data.magnification = parseInt(this.data.data[constants.extractedMap.MAGNIFICATIONKEY].data);
		}

		async addScale(type=constants.scale.types.BELOW, settings={}) {
			settings.belowColor = settings.belowColor ? settings.belowColor : constants.scale.colors.AUTO;
			settings.scaleColor = settings.scaleColor ? settings.scaleColor : constants.scale.colors.AUTO;
			settings.scaleSize = settings.scaleSize ? settings.scaleSize : constants.scale.AUTOSIZE;
			settings.scaleBarHeight = settings.scaleBarHeight ? settings.scaleBarHeight : constants.scale.AUTOSIZE;

			const initialImage = await Jimp.read(this.data.files.image);

			const [scale, image] = await calculations.calculateScale(initialImage, this.data.magnification, type, settings.belowColor, settings.scaleSize);

			let isBlack = settings.scaleColor === constants.scale.colors.WHITE;
			if (settings.scaleColor === constants.scale.colors.AUTO) {
				// Finds general luminosity of text area
				isBlack = calculations.sumPixelLuminosity(image, scale.x, scale.y, scale.width, scale.height) < .5;
			}

			const scaleBarHeight = Math.round((settings.scaleBarHeight ? settings.scaleBarHeight : .08) * scale.height);

			// Creates scale bar and scale text on image
			for (let i = 0; i < scaleBarHeight; i++)
				await image.print(
					isBlack ? fonts.white.small : fonts.black.small,
					scale.x,
					scale.y - 15 + i,
					scale.scaleBar
				);

			await image.print(
				isBlack ? fonts.white[scale.scaleSize.font] : fonts.black[scale.scaleSize.font],
				scale.x,
				scale.y + 10,
				'' + scale.visualScale + 'µm'
			);

			this.data.image = image;
		}

		async writeImage(settings={}) {
			let outputUri = settings.uri ? settings.uri : (this.data.files.image.substring(0, this.data.files.image.length - (constants.extractedMap.fileFormats.IMAGERAW.length)));
			outputUri += (outputUri.endsWith(constants.extractedMap.fileFormats.OUTPUTIMAGE) ? '' : constants.extractedMap.fileFormats.OUTPUTIMAGE);

			return await this.data.image.writeAsync(outputUri);
		}

		async addScaleAndWrite(type=undefined, settings={}) {
			await this.addScale(type, settings);
			await this.writeImage(settings);
			this.data.image = undefined;
		}
	}
};