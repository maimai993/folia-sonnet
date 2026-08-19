import type { Filter } from 'pixi.js';
import { parseColorChannels } from '../colorMix';

// src/components/visualizer/tempera/temperaDifferenceFilter.ts
// Single-pass threshold inversion for the lyric layer: it samples the already-rendered
// artwork underneath and paints each text pixel in whichever of ink/paper contrasts more,
// giving the print-registration look without hand-picking a fill color per shot kind.
type PixiModule = typeof import('pixi.js');

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uBackTexture;
uniform highp vec4 uInputSize;
uniform vec3 uInkColor;
uniform vec3 uPaperColor;
uniform float uInkLuminance;
uniform float uPaperLuminance;
uniform float uBias;

float backLuminance(vec2 uv) {
    vec4 back = texture(uBackTexture, uv);
    // Pixi render targets are premultiplied; undo it before reading brightness.
    vec3 straight = back.rgb / max(back.a, 1e-4);
    float lum = dot(straight, vec3(0.2126, 0.7152, 0.0722));
    // Where nothing has been drawn, the shell background shows through, which is paper.
    return mix(uPaperLuminance, lum, clamp(back.a * 3.0, 0.0, 1.0));
}

void main(void) {
    vec4 front = texture(uTexture, vTextureCoord);
    // A 5-tap average keeps fine hatch from flickering the inversion decision per pixel.
    vec2 texel = uInputSize.zw * 1.5;
    float lum = backLuminance(vTextureCoord) * 0.4
        + (backLuminance(vTextureCoord + texel)
            + backLuminance(vTextureCoord - texel)
            + backLuminance(vTextureCoord + vec2(texel.x, -texel.y))
            + backLuminance(vTextureCoord + vec2(-texel.x, texel.y))) * 0.15;

    float distanceToPaper = abs(lum - uPaperLuminance);
    float distanceToInk = abs(lum - uInkLuminance);
    // Pick the color that sits further from the backdrop so contrast never collapses,
    // whether the theme puts light ink on dark paper or the reverse.
    vec3 tone = mix(uInkColor, uPaperColor, step(distanceToInk + uBias, distanceToPaper));
    finalColor = vec4(tone * front.a, front.a);
}
`;

const REC709 = { r: 0.2126, g: 0.7152, b: 0.0722 };

const toNormalizedRgb = (color: string, fallback: [number, number, number]) => {
    const channels = parseColorChannels(color);
    if (!channels) return fallback;
    return [channels.r / 255, channels.g / 255, channels.b / 255] as [number, number, number];
};

const luminanceOf = (rgb: [number, number, number]) => (
    rgb[0] * REC709.r + rgb[1] * REC709.g + rgb[2] * REC709.b
);

export interface TemperaDifferenceOptions {
    ink: string;
    paper: string;
    /** 0..1; 0.5 is neutral, higher biases the decision toward ink. */
    threshold?: number;
}

export const createTemperaDifferenceFilter = (
    pixi: PixiModule,
    options: TemperaDifferenceOptions,
): Filter => {
    const ink = toNormalizedRgb(options.ink, [1, 1, 1]);
    const paper = toNormalizedRgb(options.paper, [0, 0, 0]);
    const uniforms = new pixi.UniformGroup({
        uInkColor: { value: new Float32Array(ink), type: 'vec3<f32>' },
        uPaperColor: { value: new Float32Array(paper), type: 'vec3<f32>' },
        uInkLuminance: { value: luminanceOf(ink), type: 'f32' },
        uPaperLuminance: { value: luminanceOf(paper), type: 'f32' },
        uBias: { value: (options.threshold ?? 0.5) - 0.5, type: 'f32' },
    });
    return new pixi.Filter({
        glProgram: pixi.GlProgram.from({
            vertex,
            fragment,
            name: 'tempera-difference-inversion',
        }),
        // blendRequired makes Pixi snapshot the pixels already drawn beneath this filter's
        // bounds into uBackTexture; the empty texture below is the required placeholder.
        blendRequired: true,
        resources: {
            differenceUniforms: uniforms,
            uBackTexture: pixi.Texture.EMPTY,
        },
        padding: 0,
        // MUST be 'inherit'. Pixi's Filter default is a hard 1, which allocates the input
        // texture at a different pixel size than the back texture (that one always follows the
        // render target's resolution). vTextureCoord then indexes the two textures
        // differently and the backdrop is read from the wrong place - the inversion picks the
        // wrong colour in patches, worst over fine hatch.
        resolution: 'inherit',
    });
};
