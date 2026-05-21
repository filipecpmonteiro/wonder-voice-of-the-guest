import Link from "next/link";
import { Logo } from "./Logo";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur bg-[var(--color-cream)]/85 border-b border-[var(--color-line)]">
      <div className="max-w-6xl mx-auto px-4 md:px-8 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <Logo size={26} />
          <div className="leading-tight">
            <div className="font-semibold text-[15px] tracking-tight">Cristina × Wonder</div>
            <div className="text-[10px] uppercase tracking-[0.13em] text-[var(--color-ink-mute)] -mt-0.5">
              Guest experience showcase
            </div>
          </div>
        </Link>
        <div className="px-3 py-1.5 rounded-full text-sm bg-[var(--color-pink-100)] text-[var(--color-pink-700)] font-medium">
          Voice of the Guest
        </div>
      </div>
    </header>
  );
}
