import { describe, it, expect } from "vitest";
import { AUTOMATION_TEMPLATES, resolveAutomationTemplate } from "./templates";

describe("resolveAutomationTemplate", () => {
  it("substitutes name, description and the text-bearing step via t()", () => {
    const calls: string[] = [];
    const t = (key: "name" | "description" | "text") => {
      calls.push(key);
      return `TRANSLATED_${key.toUpperCase()}`;
    };

    const resolved = resolveAutomationTemplate("welcome_message", t);

    expect(resolved.name).toBe("TRANSLATED_NAME");
    expect(resolved.description).toBe("TRANSLATED_DESCRIPTION");
    expect(calls).toEqual(
      expect.arrayContaining(["name", "description", "text"]),
    );

    const sendStep = resolved.steps[0];
    expect(sendStep.step_type).toBe("send_message");
    expect((sendStep.step_config as { text: string }).text).toBe(
      "TRANSLATED_TEXT",
    );

    // Every other field on the step is untouched.
    const addTagStep = resolved.steps[1];
    expect(addTagStep).toEqual(AUTOMATION_TEMPLATES.welcome_message.steps[1]);
  });

  it("substitutes the text-bearing step for every template slug", () => {
    const t = () => "X";
    for (const slug of Object.keys(AUTOMATION_TEMPLATES) as Array<
      keyof typeof AUTOMATION_TEMPLATES
    >) {
      const resolved = resolveAutomationTemplate(slug, t);
      const textSteps = resolved.steps.filter(
        (s) => s.step_type === "send_message",
      );
      expect(textSteps.length).toBeGreaterThan(0);
      expect(
        textSteps.some(
          (s) => (s.step_config as { text?: string }).text === "X",
        ),
      ).toBe(true);
    }
  });

  it("leaves non-text step config fields untouched (out_of_office condition step)", () => {
    const t = () => "X";
    const resolved = resolveAutomationTemplate("out_of_office", t);
    const conditionStep = resolved.steps[0];
    expect(conditionStep.step_config).toEqual(
      AUTOMATION_TEMPLATES.out_of_office.steps[0].step_config,
    );
  });
});
