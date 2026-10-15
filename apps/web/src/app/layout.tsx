import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dynamic Procurement Workbook",
  description: "Workspace perhitungan dan pencatatan procurement.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return <html lang="id"><body>{children}</body></html>;
}
