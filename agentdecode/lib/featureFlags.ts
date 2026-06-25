/**
 * Server-side feature flags based on environment variables.
 *
 * Checks at request time whether optional API keys are configured,
 * allowing the UI to show clear status messages instead of
 * infinite loading spinners.
 */

export interface FeatureStatus {
  /** Groq-based LLM output quality scoring */
  evalScoringEnabled: boolean
  /** Gemini-based AI failure explanations */
  explanationsEnabled: boolean
  /** Email-based alert delivery via Resend */
  alertsEnabled: boolean
}

/**
 * Check which optional features are available based on
 * current environment variable configuration.
 *
 * Call this in server components or API routes only
 * (reads process.env at request time).
 */
export function getFeatureStatus(): FeatureStatus {
  return {
    evalScoringEnabled: !!process.env.GROQ_API_KEY,
    explanationsEnabled: !!process.env.GEMINI_API_KEY,
    alertsEnabled: !!process.env.RESEND_API_KEY,
  }
}
