import { describe, expect, it } from "vitest";
import { H } from "./common.js";
import { SHADER_NAMES, getFragSource, registerShader, registeredShaderNames } from "./registry.js";

const BODY =
  "void main(){gl_FragColor=mix(texture2D(u_from,v_uv),texture2D(u_to,v_uv),u_progress);}";

describe("registerShader", () => {
  it("serves a registered shader behind the shared header", () => {
    registerShader("test-mix", BODY);
    expect(getFragSource("test-mix")).toBe(H + BODY);
    expect(registeredShaderNames()).toContain("test-mix");
  });

  it("keeps built-in shaders untouchable", () => {
    expect(() => registerShader(SHADER_NAMES[0], BODY)).toThrow(/built-in/);
    expect(getFragSource(SHADER_NAMES[0])).not.toBe(H + BODY);
  });

  it("refuses bad names and bodies without main()", () => {
    expect(() => registerShader("Bad Name", BODY)).toThrow(/Invalid shader name/);
    expect(() => registerShader("no-main", "float x;")).toThrow(/main\(\)/);
  });

  it("lists registered shaders in the unknown-shader error", () => {
    registerShader("test-listed", BODY);
    expect(() => getFragSource("missing")).toThrow(/test-listed/);
  });
});
