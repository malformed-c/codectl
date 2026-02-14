import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { loadFullConfig } from "../config";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const TEST_DIR = "test-config-dir";

describe("Config Loader", () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR);
      mkdirSync(join(TEST_DIR, "models"));
    }

    const mainConfig = {
      api_server: "http://localhost:1234",
      api_type: "test-api",
      history_path: "./test-history",
      default_model: "test-model",
      available_models: ["models/test-model.yaml"]
    };

    const modelProfile = {
      name: "test-model",
      markers: {
        systemOpen: "S:", systemClose: "\n",
        userOpen: "U:", userClose: "\n",
        modelOpen: "A:", modelClose: "\n",
        reasoningOpen: "<r>", reasoningClose: "</r>",
        stopSequence: "END"
      },
      parameters: { temp: 0.5 }
    };

    writeFileSync(join(TEST_DIR, "config.yaml"), yaml.dump(mainConfig));
    writeFileSync(join(TEST_DIR, "models/test-model.yaml"), yaml.dump(modelProfile));
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("loadFullConfig loads config and profiles correctly", async () => {
    const { config, profiles } = await loadFullConfig(join(TEST_DIR, "config.yaml"));

    expect(config.api_server).toBe("http://localhost:1234");
    expect(config.default_model).toBe("test-model");
    expect(Object.keys(profiles)).toContain("test-model");
    expect(profiles["test-model"].markers.reasoningOpen).toBe("<r>");
  });
});
