import * as faceapi from 'face-api.js';

const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

export const loadModels = async () => {
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
};

export const getFaceDescriptor = async (image: HTMLVideoElement | HTMLImageElement) => {
  try {
    // Ensure video is ready if it's a video element
    if (image instanceof HTMLVideoElement && (image.paused || image.ended)) {
      return null;
    }

    const detection = await faceapi
      .detectSingleFace(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    
    return detection?.descriptor;
  } catch (error) {
    console.error('Face detection error:', error);
    return null;
  }
};

export const compareFaces = (descriptor1: Float32Array, descriptor2: Float32Array) => {
  const distance = faceapi.euclideanDistance(descriptor1, descriptor2);
  return distance < 0.6; // Threshold for recognition
};
