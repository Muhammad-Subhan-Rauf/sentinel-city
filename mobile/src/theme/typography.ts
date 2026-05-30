// Type-scale presets built on Atkinson Hyperlegible. Color is intentionally
// omitted — components apply it from the theme so a preset works in both modes.
// Consumed by the <Text> primitive (components/ui/Text).

import { TextStyle } from 'react-native';
import { fonts, fontSize, lineHeight } from './tokens';

export type TypeVariant =
  | 'display' // hero numerals / splash
  | 'title' // screen titles
  | 'h1'
  | 'h2'
  | 'h3'
  | 'body'
  | 'bodyStrong'
  | 'callout'
  | 'label' // buttons, chips
  | 'caption'
  | 'overline' // tiny uppercase section kickers
  | 'mono';

export const typography: Record<TypeVariant, TextStyle> = {
  display: { fontFamily: fonts.bold, fontSize: fontSize.display, lineHeight: lineHeight.display, letterSpacing: -0.5 },
  title: { fontFamily: fonts.bold, fontSize: fontSize.xxl, lineHeight: lineHeight.xxl, letterSpacing: -0.4 },
  h1: { fontFamily: fonts.bold, fontSize: fontSize.xl, lineHeight: lineHeight.xl, letterSpacing: -0.2 },
  h2: { fontFamily: fonts.bold, fontSize: fontSize.lg, lineHeight: lineHeight.lg },
  h3: { fontFamily: fonts.bold, fontSize: fontSize.md, lineHeight: lineHeight.md },
  body: { fontFamily: fonts.regular, fontSize: fontSize.base, lineHeight: lineHeight.base },
  bodyStrong: { fontFamily: fonts.bold, fontSize: fontSize.base, lineHeight: lineHeight.base },
  callout: { fontFamily: fonts.regular, fontSize: fontSize.md, lineHeight: lineHeight.md },
  label: { fontFamily: fonts.bold, fontSize: fontSize.sm, lineHeight: lineHeight.sm, letterSpacing: 0.2 },
  caption: { fontFamily: fonts.regular, fontSize: fontSize.xs, lineHeight: lineHeight.xs },
  overline: { fontFamily: fonts.bold, fontSize: fontSize.xs, lineHeight: lineHeight.xs, letterSpacing: 1.4, textTransform: 'uppercase' },
  mono: { fontFamily: fonts.mono, fontSize: fontSize.sm, lineHeight: lineHeight.sm },
};
