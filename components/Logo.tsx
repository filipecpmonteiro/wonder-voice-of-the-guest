export function Logo({ size = 28 }: { size?: number }) {
  // Wonder mark: vivid green badge with a cursive lowercase "w".
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-label="Wonder"
    >
      <rect width="40" height="40" rx="5" fill="#0a3d1c" />
      <circle cx="20" cy="20" r="17" fill="#1a8a3a" />
      <text
        x="20"
        y="21.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#0a3d1c"
        fontFamily="'Brush Script MT', 'Snell Roundhand', 'Lucida Handwriting', cursive"
        fontSize="28"
        fontStyle="italic"
        fontWeight="700"
      >
        w
      </text>
    </svg>
  );
}
