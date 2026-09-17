import { describe, it, expect } from "vitest";
import { getFlowTemplate, listFlowTemplates, resolveFlowTemplate } from "./templates";

describe("resolveFlowTemplate", () => {
  it("substitutes name, description and every customer-facing node field", () => {
    const t = (key: string) => `T:${key}`;
    const resolved = resolveFlowTemplate("welcome_menu", t);

    expect(resolved.name).toBe("T:name");
    expect(resolved.description).toBe("T:description");

    const welcomeNode = resolved.nodes.find((n) => n.node_key === "welcome")!;
    const cfg = welcomeNode.config as {
      text: string;
      footer_text: string;
      buttons: Array<{ reply_id: string; title: string }>;
    };
    expect(cfg.text).toBe("T:nodes.welcome.text");
    expect(cfg.footer_text).toBe("T:nodes.welcome.footer_text");
    expect(cfg.buttons.find((b) => b.reply_id === "existing")?.title).toBe(
      "T:nodes.welcome.buttons.existing.title",
    );
    expect(cfg.buttons.find((b) => b.reply_id === "new")?.title).toBe(
      "T:nodes.welcome.buttons.new.title",
    );
  });

  it("leaves an internal handoff note untouched (never sent to the customer)", () => {
    const t = () => "X";
    const resolved = resolveFlowTemplate("welcome_menu", t);
    const handoff = resolved.nodes.find((n) => n.node_key === "existing_handoff")!;
    const original = getFlowTemplate("welcome_menu")!.nodes.find(
      (n) => n.node_key === "existing_handoff",
    )!;
    expect(handoff.config).toEqual(original.config);
  });

  it("resolves send_list sections and rows (faq_bot)", () => {
    const t = (key: string) => `T:${key}`;
    const resolved = resolveFlowTemplate("faq_bot", t);
    const topics = resolved.nodes.find((n) => n.node_key === "topics")!;
    const cfg = topics.config as {
      text: string;
      button_label: string;
      sections: Array<{
        title?: string;
        rows: Array<{ reply_id: string; title: string }>;
      }>;
    };
    expect(cfg.text).toBe("T:nodes.topics.text");
    expect(cfg.button_label).toBe("T:nodes.topics.button_label");
    expect(cfg.sections[0].title).toBe("T:nodes.topics.sections.0.title");
    expect(cfg.sections[1].title).toBe("T:nodes.topics.sections.1.title");
    expect(
      cfg.sections
        .flatMap((s) => s.rows)
        .find((r) => r.reply_id === "hours")?.title,
    ).toBe("T:nodes.topics.rows.hours.title");
  });

  it("resolves collect_input prompt_text for every node (lead_capture)", () => {
    const t = (key: string) => `T:${key}`;
    const resolved = resolveFlowTemplate("lead_capture", t);
    const collectNodes = resolved.nodes.filter((n) => n.node_type === "collect_input");
    expect(collectNodes.length).toBe(3);
    for (const node of collectNodes) {
      expect((node.config as { prompt_text: string }).prompt_text).toBe(
        `T:nodes.${node.node_key}.prompt_text`,
      );
    }
  });

  it("resolves every listed template without throwing", () => {
    const t = () => "X";
    for (const template of listFlowTemplates()) {
      expect(() => resolveFlowTemplate(template.slug, t)).not.toThrow();
    }
  });

  it("throws on an unknown slug", () => {
    expect(() => resolveFlowTemplate("does_not_exist", () => "X")).toThrow();
  });
});
