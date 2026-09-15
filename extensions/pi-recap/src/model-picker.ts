import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui"
import {
  DEFAULT_RECAP_MODEL,
  formatRecapModelKey,
  type RecapModelPreference,
} from "./models.js"

const MAX_VISIBLE_ITEMS = 10

export type ModelPickerResult =
  | { action: "default" }
  | { action: "model"; model: RecapModelPreference }
  | { action: "cancel" }

interface ModelPickerItem {
  readonly label: string
  readonly description?: string
  readonly model?: RecapModelPreference
}

class RecapModelPicker implements Component, Focusable {
  private readonly theme: Theme
  private readonly items: ModelPickerItem[]
  private readonly onDone: (result: ModelPickerResult) => void
  private readonly searchInput = new Input()
  private selectedIndex = 0

  constructor(
    theme: Theme,
    models: readonly RecapModelPreference[],
    onDone: (result: ModelPickerResult) => void,
  ) {
    this.theme = theme
    this.items = [
      {
        label: "Use default",
        description: formatRecapModelKey(DEFAULT_RECAP_MODEL),
      },
      ...models.map((model) => ({
        label: formatRecapModelKey(model),
        model,
      })),
    ]
    this.onDone = onDone
  }

  get focused(): boolean {
    return this.searchInput.focused
  }

  set focused(value: boolean) {
    this.searchInput.focused = value
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  render(width: number): string[] {
    const filteredItems = this.getFilteredItems()
    const startIndex = getVisibleStartIndex(
      this.selectedIndex,
      filteredItems.length,
    )
    const visibleItems = filteredItems.slice(
      startIndex,
      startIndex + MAX_VISIBLE_ITEMS,
    )
    const lines = [
      this.theme.fg("accent", this.theme.bold("Recap model")),
      this.theme.fg("dim", "Search"),
      ...this.searchInput.render(width),
      "",
    ]

    if (visibleItems.length === 0) {
      lines.push(this.theme.fg("warning", "No matching models"))
    } else {
      for (const [index, item] of visibleItems.entries()) {
        lines.push(
          this.renderItem(item, startIndex + index === this.selectedIndex),
        )
      }
    }

    if (filteredItems.length > MAX_VISIBLE_ITEMS) {
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(
            `${this.selectedIndex + 1}/${filteredItems.length}`,
            width,
          ),
        ),
      )
    }

    lines.push(
      "",
      this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
    )
    return lines.map((line) => truncateToWidth(line, width))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone({ action: "cancel" })
      return
    }

    if (matchesKey(data, Key.enter)) {
      this.selectCurrent()
      return
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1)
      return
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1)
      return
    }

    const previousFilter = this.getFilter()
    this.searchInput.handleInput(data)
    if (this.getFilter() !== previousFilter) {
      this.selectedIndex = 0
    }
  }

  private renderItem(item: ModelPickerItem, isSelected: boolean): string {
    const prefix = isSelected ? "→ " : "  "
    const label = isSelected
      ? this.theme.fg("accent", item.label)
      : this.theme.fg("text", item.label)
    const description = item.description
      ? this.theme.fg("dim", ` ${item.description}`)
      : ""
    return `${prefix}${label}${description}`
  }

  private moveSelection(delta: number): void {
    const count = this.getFilteredItems().length
    if (count === 0) return
    this.selectedIndex = (this.selectedIndex + delta + count) % count
  }

  private selectCurrent(): void {
    const item = this.getFilteredItems()[this.selectedIndex]
    if (!item) return

    const model = item.model
    if (!model) {
      this.onDone({ action: "default" })
      return
    }

    this.onDone({ action: "model", model })
  }

  private getFilter(): string {
    return this.searchInput.getValue().trim().toLowerCase()
  }

  private getFilteredItems(): ModelPickerItem[] {
    const filter = this.getFilter()
    if (!filter) return this.items
    return this.items.filter(
      (item) =>
        item.label.toLowerCase().includes(filter) ||
        item.description?.toLowerCase().includes(filter),
    )
  }
}

function getVisibleStartIndex(
  selectedIndex: number,
  itemCount: number,
): number {
  return Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
      itemCount - MAX_VISIBLE_ITEMS,
    ),
  )
}

class HiddenFooter implements Component {
  invalidate(): void {}

  render(): string[] {
    return []
  }
}

export async function pickRecapModel(
  ctx: ExtensionContext,
  models: readonly RecapModelPreference[],
): Promise<ModelPickerResult> {
  if (!ctx.hasUI) return { action: "cancel" }

  ctx.ui.setFooter(() => new HiddenFooter())
  return ctx.ui
    .custom<ModelPickerResult>((tui, theme, _keybindings, done) => {
      const picker = new RecapModelPicker(theme, models, done)
      return {
        get focused() {
          return picker.focused
        },
        set focused(value: boolean) {
          picker.focused = value
        },
        render: (width) => picker.render(width),
        invalidate: () => picker.invalidate(),
        handleInput: (data) => {
          picker.handleInput(data)
          tui.requestRender()
        },
      }
    })
    .finally(() => ctx.ui.setFooter(undefined))
}
