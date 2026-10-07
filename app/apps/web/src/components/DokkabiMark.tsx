import type { SVGProps } from "react";

/** The Dokkabi fire mark; task status is represented separately. */
export function DokkabiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fill="currentColor"
        d="M35 4C38 17 22 20 26 33C30 31 34 26 34 22C49 31 54 43 46 53C38 64 20 63 13 51C5 37 19 27 19 19C22 22 24 24 24 27C21 15 33 13 35 4Z"
      />
      <path
        fill="var(--background, #151c24)"
        d="M33 35C34 42 24 44 25 50C26 57 37 59 40 51C43 44 36 42 33 35Z"
      />
    </svg>
  );
}
