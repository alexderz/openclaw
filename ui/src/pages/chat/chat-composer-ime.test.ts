/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposerProps,
  findPrimaryButton,
  renderComposerFixture,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import {
  COMPOSITION_SEND_TIMEOUT_MS,
  SUBMISSION_ECHO_WINDOW_MS,
} from "./components/chat-composer-state.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

afterEach(() => resetComposerFixture());

function getComposerTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Expected composer textarea");
  }
  return textarea;
}

describe("chat composer IME composition", () => {
  it.each(["keyup", "blur", "keydown"])(
    "allows an immediate deliberate Enter after %s without affecting another composer",
    (type) => {
      const first = renderComposerFixture({ draft: "日本語" });
      const second = renderComposerFixture({ draft: "another draft" });
      const textarea = getComposerTextarea(first.container);
      const end = new CompositionEvent("compositionend", { bubbles: true });
      textarea.dispatchEvent(end);
      const enter = () => {
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
        Object.defineProperty(event, "timeStamp", { value: end.timeStamp + 1 });
        return event;
      };
      getComposerTextarea(second.container).dispatchEvent(enter());
      expect(second.props.onSend).toHaveBeenCalledOnce();
      expect(first.props.onSend).not.toHaveBeenCalled();

      textarea.dispatchEvent(
        type === "blur"
          ? new FocusEvent("blur")
          : new KeyboardEvent(type, { key: type === "keydown" ? "Meta" : "Enter", bubbles: true }),
      );
      textarea.dispatchEvent(enter());
      expect(first.props.onSend).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { sendShortcut: "enter", modifiers: {}, confirmOffset: -1 },
    { sendShortcut: "enter", modifiers: {}, confirmOffset: 1 },
    { sendShortcut: "modifier-enter", modifiers: { ctrlKey: true }, confirmOffset: 1 },
    { sendShortcut: "modifier-enter", modifiers: { metaKey: true }, confirmOffset: 1 },
  ] as const)(
    "keeps a Safari composition-confirm Enter in the draft: %j",
    ({ sendShortcut, modifiers, confirmOffset }) => {
      const onSend = vi.fn();
      const onDraftChange = vi.fn();
      const props = createComposerProps({ onSend, onDraftChange, sendShortcut });
      const container = document.createElement("div");
      render(renderChatComposer(props), container);
      const textarea = getComposerTextarea(container);
      textarea.style.height = "42px";
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      for (const value of ["shi", "shichang"]) {
        textarea.value = value;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      }
      expect(textarea.style.height).toBe("42px");
      textarea.value = "日本語";
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
      textarea.dispatchEvent(end);
      expect(textarea.style.height).not.toBe("42px");
      render(renderChatComposer({ ...props, draft: "日本語" }), container);

      for (const offset of [confirmOffset, 99, 100]) {
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });
        Object.defineProperty(enter, "timeStamp", { value: end.timeStamp + offset });
        textarea.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(offset === 100);
        expect(onSend).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
        if (offset !== 100) {
          expect(textarea.value).toBe("日本語");
        }
      }
      expect(onDraftChange).toHaveBeenCalledWith("日本語", undefined);
    },
  );

  it("leaves active IME keys to the browser and recovers Enter-send after blur", () => {
    // Browsers can drop compositionend (detach/blur mid-IME). The composing
    // flag persists across renders, so without the blur reset Enter, history
    // keys, and command menus stay dead until the Send button is clicked.
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: null,
    }));
    const onSend = vi.fn();
    const container = renderComposerFixture({ onHistoryKeydown, onSend, draft: "hello" }).container;
    const textarea = getComposerTextarea(container);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "dangqian";
    for (const key of ["Enter", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSend).not.toHaveBeenCalled();
    expect(onHistoryKeydown).not.toHaveBeenCalled();
    expect(textarea.value).toBe("dangqian");

    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(enterEvent);

    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("invalidates after handled input history navigation", () => {
    const onRequestUpdate = vi.fn();
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: "up" as const,
    }));
    const container = renderComposerFixture({ onHistoryKeydown, onRequestUpdate }).container;
    const textarea = getComposerTextarea(container);
    const arrowEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(arrowEvent);
    expect(arrowEvent.defaultPrevented).toBe(true);
    expect(onHistoryKeydown).toHaveBeenCalledOnce();
    expect(onRequestUpdate).toHaveBeenCalledOnce();
  });
});

describe("chat composer IME send (DER-607)", () => {
  // A phone host that clears its draft on send, like the chat page does.
  function renderSendHost({
    coarsePointer = true,
    ...overrides
  }: { coarsePointer?: boolean } & Partial<Parameters<typeof createComposerProps>[0]> = {}) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: coarsePointer && query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    let draft = "";
    const sent: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props = createComposerProps({
      getDraft: () => draft,
      onDraftChange: (next) => {
        draft = next;
      },
      onRequestUpdate: () => rerender(),
      onSend: vi.fn(() => {
        sent.push(draft);
        draft = "";
        rerender();
      }),
      ...overrides,
    });
    const rerender = () => render(renderChatComposer({ ...props, draft }), container);
    rerender();
    const textarea = getComposerTextarea(container);
    textarea.focus();
    const compose = (text: string) => {
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
      textarea.value = text;
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    };
    const startComposition = (text: string) => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      compose(text);
    };
    const endComposition = () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: textarea.value }),
      );
      rerender();
    };
    const clickSend = () => {
      const send = findPrimaryButton(container);
      expect(send.disabled).toBe(false);
      send.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      send.click();
    };
    const pressEnter = () => {
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    };
    // Send cuts the dictation short (the IME never commits in time), clearing
    // the composer under the open composition, which the clear then ends.
    const sendCutShort = (text: string) => {
      vi.useFakeTimers();
      startComposition(text);
      clickSend();
      vi.advanceTimersByTime(COMPOSITION_SEND_TIMEOUT_MS);
      expect(sent.at(-1)).toBe(text);
      expect(textarea.value).toBe("");
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    };
    return {
      container,
      props,
      sent,
      textarea,
      compose,
      startComposition,
      endComposition,
      clickSend,
      pressEnter,
      sendCutShort,
      draft: () => draft,
    };
  }

  it("sends dictation once, with the final word the IME commits after Send", () => {
    const host = renderSendHost();
    host.startComposition("But yeah what's going");

    host.clickSend();
    expect(host.props.onSend).not.toHaveBeenCalled();

    host.compose("But yeah what's going on");
    host.endComposition();

    expect(host.props.onSend).toHaveBeenCalledOnce();
    expect(host.sent).toEqual(["But yeah what's going on"]);
    expect(host.textarea.value).toBe("");
  });

  it("treats a repeated Send while the IME commits as the same action", () => {
    vi.useFakeTimers();
    const host = renderSendHost();
    host.startComposition("But yeah what's going");

    host.clickSend();
    const send = findPrimaryButton(host.container);
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-busy")).toBe("true");
    send.click();
    host.compose("But yeah what's going on");
    host.endComposition();
    vi.advanceTimersByTime(COMPOSITION_SEND_TIMEOUT_MS * 2);

    expect(host.sent).toEqual(["But yeah what's going on"]);
  });

  it("sends the committed dictation when blur ends the composition", () => {
    const host = renderSendHost();
    host.startComposition("But yeah what's going");
    host.clickSend();

    host.compose("But yeah what's going on");
    host.textarea.dispatchEvent(new FocusEvent("blur"));

    expect(host.sent).toEqual(["But yeah what's going on"]);
  });

  it("sends after the bounded wait when the IME never commits", () => {
    vi.useFakeTimers();
    const host = renderSendHost();
    host.startComposition("But yeah what's going");

    host.clickSend();
    vi.advanceTimersByTime(COMPOSITION_SEND_TIMEOUT_MS - 1);
    expect(host.props.onSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(host.sent).toEqual(["But yeah what's going"]);
  });

  it("keeps sending a desktop IME composition at once", () => {
    const host = renderSendHost({ coarsePointer: false });
    host.startComposition("ni hao");

    host.clickSend();

    expect(host.sent).toEqual(["ni hao"]);
  });

  it.each([
    { name: "the same draft", replay: "But yeah what's going", left: "" },
    { name: "the draft plus the missed word", replay: "But yeah what's going on", left: "on" },
  ])(
    "does not send $name a second time when the IME replays it after the send",
    ({ replay, left }) => {
      const host = renderSendHost();
      host.sendCutShort("But yeah what's going");

      // The clear cost the IME its composition; it re-commits the whole phrase.
      host.startComposition(replay);
      host.endComposition();
      expect(host.textarea.value).toBe(left);
      expect(host.draft()).toBe(left);

      host.pressEnter();
      expect(host.sent).toEqual(left ? ["But yeah what's going", left] : ["But yeah what's going"]);
    },
  );

  it("does not send the missed word alone when Send lands during the replay", () => {
    const host = renderSendHost();
    host.sendCutShort("But yeah what's going");

    host.startComposition("But yeah what's going on");
    host.clickSend();
    host.endComposition();
    vi.advanceTimersByTime(COMPOSITION_SEND_TIMEOUT_MS);

    expect(host.sent).toEqual(["But yeah what's going"]);
    expect(host.textarea.value).toBe("on");
  });

  it.each([
    { name: "a longer word", next: "But yeah what's goingest" },
    { name: "the same phrase after the window", next: "But yeah what's going", late: true },
  ])("keeps a new message that starts like the sent one: $name", ({ next, late }) => {
    const host = renderSendHost();
    host.sendCutShort("But yeah what's going");
    if (late) {
      vi.advanceTimersByTime(SUBMISSION_ECHO_WINDOW_MS + 1);
    }

    host.startComposition(next);
    host.endComposition();

    expect(host.textarea.value).toBe(next);
  });

  it("keeps the same word typed again after a keyboard send", () => {
    const host = renderSendHost();
    host.startComposition("Ok");
    host.clickSend();
    expect(host.sent).toEqual(["Ok"]);
    host.textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // Glide typing or a suggestion inserts the whole word at once.
    host.startComposition("Ok");
    host.endComposition();

    expect(host.textarea.value).toBe("Ok");
    host.pressEnter();
    expect(host.sent).toEqual(["Ok", "Ok"]);
  });

  it("keeps the busy Send in place of Stop during a run while the IME commits", () => {
    const host = renderSendHost({ canAbort: true, onAbort: vi.fn() });
    host.startComposition("But yeah what's going");
    host.clickSend();

    const primary = findPrimaryButton(host.container);
    expect(primary.classList.contains("chat-send-btn--send")).toBe(true);
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute("aria-busy")).toBe("true");
    primary.click();
    expect(host.props.onAbort).not.toHaveBeenCalled();

    host.compose("But yeah what's going on");
    host.endComposition();
    expect(host.sent).toEqual(["But yeah what's going on"]);
  });
});
