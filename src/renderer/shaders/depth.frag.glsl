#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;

uniform int uAlphaTest;
uniform int uIsLeaf;
uniform sampler2D uDiffuseMap;

out vec4 fragColor;

// Must match leaf.frag.glsl dithering to avoid shadow/silhouette mismatch
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  if (uAlphaTest > 0) {
    vec2 uv = uIsLeaf > 0 ? vec2(vUV.x, 1.0 - vUV.y) : vUV;
    float alpha = texture(uDiffuseMap, uv).a;
    float noise = interleavedGradientNoise(gl_FragCoord.xy);
    if (alpha < noise) discard;
  }
  fragColor = vec4(1.0);
}
