/**
 * Pure Node.js Image Dimension Inspector & Validator
 * Reads width and height from PNG and JPEG image headers without heavy native dependencies.
 */

const ImageValidator = {
  /**
   * Get image dimensions from Buffer
   * @param {Buffer} buffer 
   * @returns {{ width: number, height: number, type: string } | null}
   */
  getImageDimensions(buffer) {
    if (!buffer || buffer.length < 24) return null;

    // Check PNG: starts with 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      // Width is at offset 16 (4 bytes BE), Height is at offset 20 (4 bytes BE)
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height, type: 'png' };
    }

    // Check JPEG: starts with FF D8
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xFF) {
          offset++;
          continue;
        }

        const marker = buffer[offset + 1];
        // SOF0 (0xC0) or SOF2 (0xC2) contains image dimensions
        if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height, type: 'jpeg' };
        }

        // Advance to next marker
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }

    return null;
  },

  /**
   * Strictly validates photo dimensions (300 x 300)
   */
  validatePhoto(buffer) {
    const dim = this.getImageDimensions(buffer);
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

  /**
   * Strictly validates signature dimensions (300 x 80)
   */
  validateSignature(buffer) {
    const dim = this.getImageDimensions(buffer);
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

module.exports = ImageValidator;
