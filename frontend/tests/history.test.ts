import { expect, test, describe, afterAll } from "bun:test";
import { HistoryManager } from "../history";
import { rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_HISTORY_DIR = "test-history-dir";

describe("History Manager", () => {
  afterAll(() => {
    rmSync(TEST_HISTORY_DIR, { recursive: true, force: true });
  });

  test("save and load history", async () => {
    const manager = new HistoryManager(TEST_HISTORY_DIR);
    const history = {
      id: "session-1",
      messages: [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi", reasoning: "Greeting" }
      ]
    };

    await manager.save(history);
    expect(existsSync(join(TEST_HISTORY_DIR, "session-1.json"))).toBe(true);

    const loaded = await manager.load("session-1");
    expect(loaded.id).toBe("session-1");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1].reasoning).toBe("Greeting");
  });

  test("load non-existent history returns empty messages", async () => {
    const manager = new HistoryManager(TEST_HISTORY_DIR);
    const loaded = await manager.load("non-existent");
    expect(loaded.messages).toHaveLength(0);
  });
});
