"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, X } from "lucide-react";
import { useId, useRef, useState } from "react";

type ExpandingSearchDockProps = {
  value: string;
  onSearch: (query: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
};

export function ExpandingSearchDock({ value, onSearch, placeholder = "Cari…", label = "Cari", disabled = false }: ExpandingSearchDockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const inputId = useId();
  const reducedMotion = useReducedMotion();
  const expanded = isExpanded || value.length > 0;
  const collapse = () => {
    restoreFocus.current = true;
    setIsExpanded(false);
    onSearch("");
  };

  return <div className="expanding-search-dock">
    <AnimatePresence mode="wait" initial={false}>
      {!expanded ? <motion.button key="icon" ref={buttonRef} type="button" className="expanding-search-trigger" aria-label={label} aria-expanded={false} disabled={disabled}
        initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ duration: reducedMotion ? 0 : .15 }}
        onAnimationComplete={() => { if (restoreFocus.current) { buttonRef.current?.focus(); restoreFocus.current = false; } }}
        onClick={() => setIsExpanded(true)}><Search aria-hidden="true" /></motion.button>
      : <motion.form key="input" className="expanding-search-form" onSubmit={event => { event.preventDefault(); onSearch(value); }}
        initial={{ width: 34, opacity: 0 }} animate={{ width: 240, opacity: 1 }} exit={{ width: 34, opacity: 0 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 30 }}>
        <div className="expanding-search-field">
          <Search className="expanding-search-icon" aria-hidden="true" />
          <input id={inputId} type="search" aria-label={label} value={value} onChange={event => onSearch(event.target.value)} placeholder={placeholder} disabled={disabled} autoFocus
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); collapse(); } }} />
          <motion.button type="button" className="expanding-search-close" aria-label="Tutup dan hapus pencarian" disabled={disabled} onClick={collapse}
            whileHover={reducedMotion ? {} : { scale: 1.1 }} whileTap={reducedMotion ? {} : { scale: .9 }}><X aria-hidden="true" /></motion.button>
        </div>
      </motion.form>}
    </AnimatePresence>
  </div>;
}
