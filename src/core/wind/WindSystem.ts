/** User-facing wind configuration values. */
export interface WindParams {
  speed: number;
  direction: number; // degrees
  turbulence: number;
  gustFrequency: number;
  gustStrength: number;
}

/**
 * Global wind state manager.
 * Provides uniform values consumed by bark and leaf vertex shaders.
 */
export class WindSystem {
  // Shared uniform references — materials bind to these
  readonly uniforms = {
    uTime: { value: 0 },
    uWindSpeed: { value: 1.0 },
    uWindDir: { value: { x: 1, y: 0 } },
    uTurbulence: { value: 0.5 },
    uGustFrequency: { value: 0.3 },
    uGustStrength: { value: 0.3 },
  };

  private params: WindParams = {
    speed: 1.0,
    direction: 0,
    turbulence: 0.5,
    gustFrequency: 0.3,
    gustStrength: 0.3,
  };

  /** Merge new wind parameter values into the current state with validation. */
  setParams(params: Partial<WindParams>) {
    if (params.speed !== undefined) this.params.speed = Math.max(0, Math.min(params.speed, 100));
    if (params.direction !== undefined) this.params.direction = isFinite(params.direction) ? params.direction : 0;
    if (params.turbulence !== undefined) this.params.turbulence = Math.max(0, Math.min(params.turbulence, 10));
    if (params.gustFrequency !== undefined) this.params.gustFrequency = Math.max(0, Math.min(params.gustFrequency, 10));
    if (params.gustStrength !== undefined) this.params.gustStrength = Math.max(0, Math.min(params.gustStrength, 10));
  }

  /** Return a snapshot of the current wind parameters. */
  getParams(): WindParams {
    return { ...this.params };
  }

  /**
   * Call each frame to update wind uniforms.
   */
  update(deltaTime: number) {
    this.uniforms.uTime.value += deltaTime;
    this.uniforms.uWindSpeed.value = this.params.speed;

    const angleRad = (this.params.direction * Math.PI) / 180;
    this.uniforms.uWindDir.value.x = Math.cos(angleRad);
    this.uniforms.uWindDir.value.y = Math.sin(angleRad);

    this.uniforms.uTurbulence.value = this.params.turbulence;
    this.uniforms.uGustFrequency.value = this.params.gustFrequency;
    this.uniforms.uGustStrength.value = this.params.gustStrength;
  }
}
