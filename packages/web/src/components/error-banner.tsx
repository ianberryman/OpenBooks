import type { ReactElement } from 'react';

import { presentApiError } from '../api/presentation';
import { cx } from '../lib/cx';
import { Button } from './button';

/**
 * The rendered form of `presentApiError`.
 *
 * A screen passes the thing it caught and gets a banner whose wording, tone, and offered
 * action already follow from the error's code — so the six M2 screens cannot disagree
 * about what a 409 means, and none of them has to remember that a 404 must not be
 * distinguished from a permission failure (A7).
 *
 * `onRetry` and `onSignIn` are supplied by the screen because only the screen knows what
 * to re-run and only the router knows where sign-in is. When the matching recovery comes
 * up and no handler was given, no button is rendered — a dead button is worse than none.
 */
export interface ErrorBannerProps {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly onSignIn?: () => void;
  readonly className?: string | undefined;
}

export function ErrorBanner({
  error,
  onRetry,
  onSignIn,
  className,
}: ErrorBannerProps): ReactElement {
  const presented = presentApiError(error);
  const showRetry = presented.recovery === 'retry' && onRetry !== undefined;
  const showSignIn = presented.recovery === 'sign-in' && onSignIn !== undefined;

  return (
    <div
      /**
       * `alert` rather than `status`: this is always the consequence of something the user
       * just did, and it interrupts for the same reason the red box does.
       */
      role="alert"
      className={cx(
        'flex items-start gap-3 rounded-lg border border-danger-border bg-danger-soft p-3',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-danger-text">{presented.title}</p>
        <p className="text-sm text-text-muted">{presented.message}</p>
      </div>
      {showRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
      {showSignIn && (
        <Button size="sm" variant="primary" onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </div>
  );
}
