import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dynamic Procurement Workbook",
  description: "Workspace perhitungan dan pencatatan procurement.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return <html lang="id">
      <body>{children}
        {process.env.NODE_ENV === "development" && (
          <Script
            src="https://unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        )}
      </body></html>;
}
