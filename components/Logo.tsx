export function Logo({ size = 28 }: { size?: number }) {
  // Wonder mark: a bold "W" inside a coral-on-navy rounded badge — modern,
  // food-hall feel, no ice-cream-specific imagery.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="Cristina × Wonder">
      <defs>
        <linearGradient id="wonderBadge" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0b1530" />
          <stop offset="1" stopColor="#1c2a4d" />
        </linearGradient>
      </defs>
      {/* badge */}
      <rect x="2" y="2" width="36" height="36" rx="10" fill="url(#wonderBadge)" />
      {/* coral W */}
      <path
        d="M9.5 13 L13.5 27 L17 19 L20 27 L23.5 19 L27 27 L31 13"
        fill="none"
        stroke="#ff7d24"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* tiny dot accent */}
      <circle cx="31.5" cy="13" r="1.6" fill="#ffc498" />
    </svg>
  );
}
