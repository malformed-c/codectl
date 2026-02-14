import { expect, test, describe } from "bun:test";
import { ModelSession } from "../model";
import { ModelProfile } from "../messages";

const mockProfile: ModelProfile = {
  name: "test-model",
  markers: {
    systemOpen: "[S]", systemClose: "[/S]",
    userOpen: "[U]", userClose: "[/U]",
    modelOpen: "[A]", modelClose: "[/A]",
    reasoningOpen: "<T>", reasoningClose: "</T>",
    stopSequence: "END"
  },
  parameters: {}
};

describe("Model Session", () => {
  test("formatPrompt formats history correctly", () => {
    const session = new ModelSession(mockProfile);
    session.addMessage("system", "Act as a helper");
    session.addMessage("user", "Hello");
    session.addMessage("assistant", "Hi", "Thinking...");

    const prompt = session.formatPrompt();
    expect(prompt).toContain("[S]Act as a helper[/S]");
    expect(prompt).toContain("[U]Hello[/U]");
    expect(prompt).toContain("[A]<T>Thinking...</T>Hi[/A]");
  });

  test("parseAssistantResponse extracts reasoning and cleans content", () => {
    const session = new ModelSession(mockProfile);
    const raw = "<T>I should be helpful</T>I can help you with that![/A]";

    const { content, reasoning } = session.parseAssistantResponse(raw);
    expect(reasoning).toBe("I should be helpful");
    expect(content).toBe("I can help you with that!");
  });

  test("addAssistantResponse adds parsed response to history", () => {
    const session = new ModelSession(mockProfile);
    const raw = "<T>Logic</T>Response";
    session.addAssistantResponse(raw);

    expect(session.history).toHaveLength(1);
    expect(session.history[0].role).toBe("assistant");
    expect(session.history[0].content).toBe("Response");
    expect(session.history[0].reasoning).toBe("Logic");
  });
});
