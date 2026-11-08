import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterModels, formatModelPrice, type SelectableModel } from "../lib/models";

const MAX_VISIBLE_RESULTS = 50;

export interface ModelPickerProps {
  inputId: string;
  models: SelectableModel[];
  /** Provider display name, used in labels and status copy. */
  providerLabel: string;
  /** Hide the free-only filter for providers without a free tier. */
  showFreeOnly?: boolean;
  value: string;
  onSelect: (id: string) => void;
  freeOnly: boolean;
  onFreeOnlyChange: (value: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function ModelPicker({
  inputId,
  models,
  providerLabel,
  showFreeOnly = true,
  value,
  onSelect,
  freeOnly,
  onFreeOnlyChange,
  disabled = false,
  loading = false,
  error = null,
  onRetry,
}: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const matching = useMemo(
    () => filterModels(models, { freeOnly: showFreeOnly && freeOnly, query }),
    [models, freeOnly, query, showFreeOnly],
  );
  const visible = matching.slice(0, MAX_VISIBLE_RESULTS);
  const selected = models.find((model) => model.id === value);
  const listId = `${inputId}-listbox`;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, freeOnly]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${inputId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, inputId, open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function choose(id: string) {
    onSelect(id);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(current + 1, Math.max(0, visible.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Home") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex(Math.max(0, visible.length - 1));
      return;
    }
    if (event.key === "Enter") {
      const model = visible[activeIndex];
      if (open && model) {
        event.preventDefault();
        choose(model.id);
      }
      return;
    }
    if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
    }
  }

  const activeModel = open ? visible[activeIndex] : undefined;

  return (
    <div className="model-picker" ref={rootRef}>
      <div className="model-toolbar">
        <span>
          {matching.length} model{matching.length === 1 ? "" : "s"}
        </span>
        {showFreeOnly && (
          <label className="model-toggle">
            <input
              type="checkbox"
              checked={freeOnly}
              disabled={disabled || loading}
              onChange={(event) => onFreeOnlyChange(event.currentTarget.checked)}
            />
            Free only
          </label>
        )}
      </div>

      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open && !loading}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeModel ? `${inputId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={loading ? "Loading models…" : "Search models…"}
        value={query}
        disabled={disabled || loading}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {loading && (
        <p className="model-status" role="status">
          Loading models from {providerLabel}…
        </p>
      )}

      {error && !loading && (
        <p className="model-error" role="alert">
          {error}{" "}
          {onRetry && (
            <button type="button" className="link-btn" onClick={onRetry} disabled={disabled}>
              Retry
            </button>
          )}
        </p>
      )}

      {open && !loading && (
        <>
          {visible.length > 0 ? (
            <div
              className="model-results"
              id={listId}
              role="listbox"
              aria-label={`${providerLabel} models`}
            >
              {visible.map((model, index) => (
                <div
                  key={model.id}
                  id={`${inputId}-option-${index}`}
                  role="option"
                  aria-selected={model.id === value}
                  className={`model-option${index === activeIndex ? " active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model.id)}
                >
                  <span className="model-option-name">
                    <span>{model.name}</span>
                    <span className={model.free ? "model-free" : "model-option-price"}>
                      {formatModelPrice(model)}
                    </span>
                  </span>
                  <span className="model-option-id">{model.id}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="model-empty">
              {showFreeOnly && freeOnly
                ? "No free models match. Uncheck “Free only” to include paid models."
                : "No models match your search."}
            </p>
          )}
          {matching.length > visible.length && (
            <p className="model-more">
              Refine your search to see more than {MAX_VISIBLE_RESULTS} models.
            </p>
          )}
        </>
      )}

      {selected && (
        <p className="model-selected">
          Selected: <strong>{selected.name}</strong> <code>{selected.id}</code> ·{" "}
          <span className={selected.free ? "model-free" : undefined}>
            {formatModelPrice(selected)}
          </span>
        </p>
      )}
    </div>
  );
}
