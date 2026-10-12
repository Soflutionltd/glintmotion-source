export function HyperframesLogo() {
  // Glintmotion mark (apps/desktop/ui/mark.svg) plus wordmark. The wordmark takes the text colour,
  // so the logo reads in both themes.
  return (
    <svg
      width={124}
      height={24}
      viewBox="0 0 124 24"
      fill="none"
      className="text-text-0"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Glintmotion"
    >
      <defs>
        <linearGradient id="gm-logo-g" x1="6" y1="58" x2="58" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-brand-gradient-from)" />
          <stop offset="1" stopColor="var(--color-brand-gradient-to)" />
        </linearGradient>
      </defs>
      <g transform="scale(0.375)">
        <path
          d="M40 6C41.7 19.2 44.8 22.3 58 24C44.8 25.7 41.7 28.8 40 42C38.3 28.8 35.2 25.7 22 24C35.2 22.3 38.3 19.2 40 6Z"
          fill="url(#gm-logo-g)"
        />
        <path d="M9 51L27 39" stroke="url(#gm-logo-g)" strokeWidth="5" strokeLinecap="round" />
        <path
          d="M17 58L30 49.3"
          stroke="url(#gm-logo-g)"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.7"
        />
        <path
          d="M6 40.5L17.5 32.8"
          stroke="url(#gm-logo-g)"
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.45"
        />
      </g>
      <text
        x="29"
        y="17"
        fill="currentColor"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif"
        fontSize="15"
        fontWeight="700"
        letterSpacing="-0.3"
      >
        Glintmotion
      </text>
    </svg>
  );
}
