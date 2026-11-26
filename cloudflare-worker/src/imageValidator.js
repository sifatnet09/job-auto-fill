/**
 * Pure Web Standard Image Dimension Validator (Uint8Array)
 * Strictly validates 300x300 photo and 300x80 signature for Teletalk
 */

export const ImageValidator = {
  getImageDimensions(uint8) {
    if (!uint8 || uint8.length < 24) return null;
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);

    // PNG signature: 89 50 4E 47
    if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      return { width, height, type: 'png' };
    }

    // JPEG signature: FF D8
    if (uint8[0] === 0xFF && uint8[1] === 0xD8) {
      let offset = 2;
      while (offset + 8 < uint8.length) {
        if (uint8[offset] !== 0xFF) {
          offset++;
          continue;
        }
        const marker = uint8[offset + 1];
        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
          const height = view.getUint16(offset + 5, false);
          const width = view.getUint16(offset + 7, false);
          return { width, height, type: 'jpeg' };
        }
        if (offset + 3 >= uint8.length) break;
        const len = view.getUint16(offset + 2, false);
        offset += 2 + len;
      }
    }

    return null;
  },

  validatePhoto(uint8) {
    const dim = this.getImageDimensions(uint8);
    if (!dim) {
      return { valid: false, message: 'Invalid image file or unsupported format. Must be JPEG or PNG.' };
    }
    if (dim.width !== 300 || dim.height !== 300) {
      return {
        valid: false,
        message: `Photo dimensions must strictly be 300x300 pixels (Teletalk standard). Received: ${dim.width}x${dim.height} pixels.`
      };
    }
    return { valid: true, dimensions: dim };
  },

  validateSignature(uint8) {
    const dim = this.getImageDimensions(uint8);
    if (!dim) {
      return { valid: false, message: 'Invalid image file or unsupported format. Must be JPEG or PNG.' };
    }
    if (dim.width !== 300 || dim.height !== 80) {
      return {
        valid: false,
        message: `Signature dimensions must strictly be 300x80 pixels (Teletalk standard). Received: ${dim.width}x${dim.height} pixels.`
      };
    }
    return { valid: true, dimensions: dim };
  }
};
