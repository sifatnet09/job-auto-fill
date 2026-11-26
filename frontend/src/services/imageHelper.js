/**
 * Client-Side Canvas Image Resizer & Strict Validator (300x300 Photo, 300x80 Signature)
 */
export const ImageHelper = {
  resizeToExact(file, targetWidth, targetHeight) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);

          const scale = Math.max(targetWidth / img.width, targetHeight / img.height);
          const drawWidth = img.width * scale;
          const drawHeight = img.height * scale;
          const dx = (targetWidth - drawWidth) / 2;
          const dy = (targetHeight - drawHeight) / 2;

          ctx.drawImage(img, dx, dy, drawWidth, drawHeight);

          canvas.toBlob((blob) => {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            resolve({ blob, dataUrl, width: targetWidth, height: targetHeight });
          }, 'image/jpeg', 0.92);
        };
        img.onerror = () => reject(new Error('Failed to load image file.'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }
};
