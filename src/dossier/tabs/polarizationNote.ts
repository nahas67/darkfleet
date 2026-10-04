/**
 * The fixed caveat shown wherever polarization is displayed.
 *
 * Single-pol is the real production architecture, so the surface has to state
 * plainly which channel was opened and which quantities therefore do not exist.
 * Without this, a short statistics table reads as though the system has no
 * cross-polarization capability at all -- which would be wrong in the other
 * direction -- or, worse, as though an unmeasured ratio were simply missing from
 * the display.
 */

export const POLARIZATION_UNAVAILABLE_NOTE =
  'Production reads ONE polarization per acquisition. A VH/VV or HV/HH ratio needs two ' +
  'co-registered channels, and no second channel is opened, so every dual-polarization ' +
  'quantity is NOT AVAILABLE. Nothing is imputed and no substitute channel is synthesised: a ' +
  'ratio built from arrays that do not describe the same point on the ground would look like ' +
  'a measurement of this vessel while describing nothing at all.';