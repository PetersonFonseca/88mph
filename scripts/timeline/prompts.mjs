// Art direction for the look-dev batch. Edit freely: a changed prompt makes a new job only if its id changes.

const CAMERA = 'The camera is rigidly mounted behind the windshield and looks straight down the avenue: it only moves forward along its lane, with no panning, no tilting, no zoom, no shake and no cuts.';
const NO_TEXT = 'No captions, no subtitles, no logos added, no text overlays.';

export const LIGHT = {
  manha: 'soft early-morning light shortly after sunrise, low warm sun, long gentle shadows, a light haze in the distance',
  dia: 'clear bright daylight around midday, crisp shadows, blue sky with a few clouds',
};

const ERA_1955 = [
  'Replace the modern towers with the avenue\'s 1950s scenery: large eclectic and art-deco mansions (casarões) set back behind front gardens, iron gates, low walls and palm trees, plus a few early modernist apartment buildings of six to twelve floors.',
  'Where the museum stands today on the right, show the open Trianon esplanade of the 1950s: a wide paved terrace with a low stone balustrade overlooking the city, with lamp posts and benches.',
  'Keep the dense trees of Parque Trianon on the left.',
  'The road surface becomes 1950s asphalt with tram tracks along the avenue and overhead tram wires hung from simple poles; simple painted lane markings.',
  'Traffic of the period: rounded 1940s and 1950s American sedans, a Volkswagen Beetle, a jeep, a city bus of the era and a tram; pedestrians in 1950s clothing (men in suits and hats, women in dresses).',
  'Ornate cast-iron street lamps.',
  'Remove every modern element: no concrete traffic barriers, no plastic fences, no bike lane, no modern cars or buses, no glass towers, no LED or digital signs, no smartphones, no satellite dishes, no modern brands.',
].join(' ');

export function edit1955(light = 'manha') {
  return [
    'Transform this street photograph into the same view on a morning in November 1955: Avenida Paulista, São Paulo, in the mid-1950s.',
    'Keep exactly the camera position, height and lens, the horizon line and the vanishing point, and the geometry of the road: the straight avenue, its lanes, curbs, sidewalks and median.',
    ERA_1955,
    `Lighting: ${LIGHT[light]}.`,
    'Photorealistic color photograph, as if taken in 1955 with a modern camera: natural colors, sharp detail, not sepia, not black and white, no film grain overlay.',
    NO_TEXT,
  ].join('\n');
}

/** Second 1955 frame further down the avenue, matched to the chosen arrival image. */
export function continuity1955() {
  return [
    'Image 1 is a present-day photograph of Avenida Paulista in São Paulo. Image 2 shows the same avenue in November 1955, about 85 meters behind the camera of image 1, looking the same way.',
    'Transform image 1 into 1955 so that it looks like the next moment of the same drive as image 2: same time of day, lighting, color grading, weather, level of detail and architectural style.',
    'Keep exactly image 1\'s camera position, lens, horizon line, vanishing point and road geometry (lanes, curbs, sidewalks).',
    ERA_1955,
    NO_TEXT,
  ].join('\n');
}

export const drivePresent = [
  'Continuous dashcam footage filmed through the windshield of a car driving forward along Avenida Paulista in São Paulo on an overcast day.',
  CAMERA,
  'Buildings, trees, poles and road markings flow past smoothly with consistent perspective and parallax. The cars ahead keep moving forward with the traffic; pedestrians walk naturally on the sidewalks.',
  'Realistic documentary look, natural colors, sharp detail, steady exposure.',
  NO_TEXT,
].join('\n');

export const drive1955 = [
  'Continuous footage filmed through the windshield of a car driving forward at a steady city speed along Avenida Paulista in São Paulo, November 1955.',
  CAMERA,
  'Mansions with gardens, palm trees and lamp posts flow past with consistent perspective and parallax. Period cars drive ahead and alongside, a tram moves along its tracks, pedestrians in 1950s clothing walk on the sidewalks.',
  'Keep the lighting, colors and architecture of the first frame throughout. Photorealistic, natural colors, sharp detail.',
  NO_TEXT,
].join('\n');

export const morphTo1955 = [
  'Continuous footage filmed through the windshield of a car driving forward along Avenida Paulista in São Paulo.',
  CAMERA,
  'While the car keeps moving, time flows backwards around it in one seamless transformation: the modern towers, cars, barriers, signs and people morph into their 1955 counterparts — mansions with gardens, tram tracks and wires, 1950s cars and pedestrians — until the scene becomes the 1955 avenue of the final frame.',
  'The road stays continuous under the car; the transformation sweeps from the horizon towards the camera. Photorealistic, natural colors.',
  NO_TEXT,
].join('\n');
