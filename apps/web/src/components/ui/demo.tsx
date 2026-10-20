"use client";

import { useState } from "react";
import { MenuToggleIcon } from "./menu-toggle-icon.tsx";

export default function DemoOne() {
  const [open, setOpen] = useState(false);
  return <button type="button" aria-label="Buka atau tutup menu" aria-expanded={open} onClick={() => setOpen(!open)}>
    <MenuToggleIcon open={open} width={80} height={80} duration={500} aria-hidden="true" />
  </button>;
}
