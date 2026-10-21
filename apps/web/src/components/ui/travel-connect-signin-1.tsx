"use client";

import { useState } from "react";
import type { FormEventHandler } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

export default function SignIn({ onSubmit, busy, error }: { onSubmit: FormEventHandler<HTMLFormElement>; busy: boolean; error: string }) {
  const [visible, setVisible] = useState(false);
  const reducedMotion = useReducedMotion();
  return <div className="signin-shell flex min-h-[100dvh] w-full items-center justify-center bg-black p-4">
      <div className="signin-form-panel flex min-h-[520px] w-full max-w-md flex-col justify-center bg-transparent p-8 md:p-10">
        <h1 className="m-0 mb-2 text-3xl font-bold text-gray-800">Selamat datang kembali</h1>
        <p className="m-0 mb-8 text-gray-500">Masuk ke akun Anda</p>
        {error && <p role="alert" className="mb-5 rounded-lg text-sm">{error}</p>}
        <form onSubmit={onSubmit} className="m-0 border-0 p-0">
          <fieldset disabled={busy} className="m-0 space-y-5 border-0 p-0">
            <div><label htmlFor="signin-email" className="m-0 mb-2 block text-sm font-medium text-gray-700">Email <span className="text-blue-500">*</span></label>
              <input id="signin-email" name="email" type="email" autoComplete="username" required placeholder="Masukkan alamat email" className="m-0 h-11 w-full rounded-lg border border-solid border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus-visible:outline-blue-500" /></div>
            <div><label htmlFor="signin-password" className="m-0 mb-2 block text-sm font-medium text-gray-700">Kata sandi <span className="text-blue-500">*</span></label>
              <div className="relative"><input id="signin-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" required placeholder="Masukkan kata sandi" className="m-0 h-11 w-full rounded-lg border border-solid border-gray-200 bg-gray-50 py-2 pl-3 pr-12 text-sm text-gray-800 placeholder:text-gray-400 focus-visible:outline-blue-500" />
                <button type="button" aria-label={visible ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"} aria-pressed={visible} onClick={() => setVisible(value => !value)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center border-0 bg-transparent p-0 text-gray-500 hover:text-gray-700">{visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button></div></div>
            <motion.button type="submit" whileHover={reducedMotion ? {} : { scale: 1.01 }} whileTap={reducedMotion ? {} : { scale: .98 }} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-4 py-3 text-sm font-medium text-white transition-shadow hover:shadow-lg hover:shadow-blue-200 disabled:opacity-50">{busy ? "Memproses…" : "Masuk"}<ArrowRight size={18} aria-hidden="true" /></motion.button>
          </fieldset>
        </form>
      </div>
  </div>;
}
