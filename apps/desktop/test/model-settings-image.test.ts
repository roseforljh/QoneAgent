import { expect, test } from "bun:test";
import { modelSettingsFromMetadata } from "../src/lib/model-settings";

test("provider metadata keeps image input separate from image output", () => {
  const settings = modelSettingsFromMetadata({ id: "vendor-image-new", supportedMethods: ["images.generations"] });
  expect(settings.input).toEqual(["text"]);
  expect(settings.output).toEqual(["image"]);
});

test("metadata and manual format remain distinguishable for later overrides", () => {
  const settings = modelSettingsFromMetadata({ id: "qwen-image-new", output: ["image"], imageApiFormat: "qwen-image" });
  expect(settings.input).toEqual(["text"]);
  expect(settings.output).toEqual(["image"]);
  expect(settings.imageApiFormat).toBeUndefined();
  expect(settings.modelMetadata?.imageApiFormat).toBe("qwen-image");
});
