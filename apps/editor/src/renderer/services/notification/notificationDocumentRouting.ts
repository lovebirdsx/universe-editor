/*---------------------------------------------------------------------------------------------
 *  notificationDocumentRouting — origin-document routing for notifications and
 *  progress, the single-renderer equivalent of VSCode creating one
 *  INotificationService / IProgressService per workbench window.
 *
 *  The services stay app-wide (one registry, one unread count, one center flag),
 *  but each item remembers the document that was active when it was created so
 *  the toast and center hosts can portal it back into that window. The map lives
 *  only in the renderer: platform's INotification must never carry a Document
 *  (it is persisted as JSON).
 *--------------------------------------------------------------------------------------------*/

import type {
  INotificationHandle,
  INotificationService,
  IObservable,
} from '@universe-editor/platform'

export type NotificationOptions = Parameters<INotificationService['notify']>[0]

export interface IDocumentAwareNotificationService extends INotificationService {
  /**
   * Like `notify`, but pins the notification to `origin` (an auxiliary window's
   * document). Callers that know where the work was started should pass it
   * explicitly; `notify` uses the document active at call time.
   */
  notifyWithOrigin(origin: Document | undefined, opts: NotificationOptions): INotificationHandle
  /** Notification id → origin document, for items created after boot. */
  readonly notificationOrigins: IObservable<ReadonlyMap<string, Document>>
  /** Document the notification center was opened in. */
  readonly centerDocument: IObservable<Document | undefined>
}
