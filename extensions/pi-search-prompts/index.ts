import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentSessionPrompts, globalPrompts } from "./history";
import { PromptSearchOverlay } from "./overlay";

async function openPromptSearch(ctx: ExtensionContext): Promise<void> {

	const selected = await ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			const overlay = new PromptSearchOverlay(
				currentSessionPrompts(ctx.sessionManager),
				theme,
				done,
				globalPrompts,
				() => tui.requestRender(),
				keybindings,
			);
			return {
				get focused() {
					return overlay.focused;
				},
				set focused(value: boolean) {
					overlay.focused = value;
				},
				render: (width: number) => overlay.render(width),
				invalidate: () => overlay.invalidate(),
				handleInput: (data: string) => {
					overlay.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "96%",
				minWidth: 48,
				maxHeight: 16,
				margin: { bottom: 1 },
			},
		},
	);

	if (selected !== undefined) ctx.ui.setEditorText(selected);
}

export default function promptSearchExtension(pi: ExtensionAPI) {
	pi.registerCommand("search-prompts", {
		description: "Search prompt history and prefill the editor",
		handler: async (_args, ctx) => openPromptSearch(ctx),
	});

	pi.registerShortcut("ctrl+r", {
		description: "Search prompt history",
		handler: async (ctx) => openPromptSearch(ctx),
	});
}
