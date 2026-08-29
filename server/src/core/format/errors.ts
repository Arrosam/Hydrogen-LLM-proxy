/**
 * Raised when a canonical request carries something the egress wire family has
 * no way to express, and inventing a substitute would be worse than failing:
 * a URL file reference for a family that only accepts inline bytes, or a
 * provider-side `file_id` that belongs to another family's storage.
 *
 * This is a request-shape fault, not a transport one. `classifyError` maps it to
 * the "error" kind so the step engine neither retries the same step (the render
 * can only fail the same way again) nor records it as a network blip — while the
 * usual advance rules still let a later step, on a family that CAN express the
 * reference, serve the request.
 */
export class FormatConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatConversionError";
  }
}
