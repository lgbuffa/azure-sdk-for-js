// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ClientEntityContext } from "../clientEntityContext";
import {
  MessageHandlers,
  ReceiveBatchOptions,
  ReceivedMessage,
  SessionMessageHandlerOptions,
  SubscribeOptions
} from "..";
import {
  BrowseMessagesOptions,
  CreateSessionReceiverOptions,
  GetMessageIteratorOptions
} from "../models";
import { MessageSession } from "../session/messageSession";
import {
  getAlreadyReceivingErrorMsg,
  getOpenSessionReceiverErrorMsg,
  getReceiverClosedErrorMsg,
  throwErrorIfConnectionClosed,
  throwTypeErrorIfParameterMissing,
  throwTypeErrorIfParameterNotLong,
  throwTypeErrorIfParameterNotLongArray
} from "../util/errors";
import * as log from "../log";
import { OnError, OnMessage } from "../core/messageReceiver";
import { assertValidMessageHandlers, getMessageIterator } from "./shared";
import { convertToInternalReceiveMode } from "../constructorHelpers";
import { Receiver } from "./receiver";
import Long from "long";
import { ReceivedMessageWithLock, ServiceBusMessageImpl } from "../serviceBusMessage";
import { Constants, RetryConfig, RetryOperationType, RetryOptions, retry } from "@azure/core-amqp";
import { OperationOptions } from "../modelsToBeSharedWithEventHubs";
import "@azure/core-asynciterator-polyfill";

/**
 *A receiver that handles sessions, including renewing the session lock.
 */
export interface SessionReceiver<
  ReceivedMessageT extends ReceivedMessage | ReceivedMessageWithLock
> extends Receiver<ReceivedMessageT> {
  /**
   * The session ID.
   */
  readonly sessionId: string;

  /**
   * @property The time in UTC until which the session is locked.
   * Everytime `renewSessionLock()` is called, this time gets updated to current time plus the lock
   * duration as specified during the Queue/Subscription creation.
   *
   * Will return undefined until a AMQP receiver link has been successfully set up for the session.
   *
   * @readonly
   */
  sessionLockedUntilUtc: Date | undefined;

  /**
   * Renews the lock on the session.
   */
  renewSessionLock(options?: OperationOptions): Promise<Date>;

  /**
   * Gets the state of the Session. For more on session states, see
   * {@link https://docs.microsoft.com/en-us/azure/service-bus-messaging/message-sessions#message-session-state Session State}
   * @param options - Options bag to pass an abort signal or tracing options.
   * @returns {Promise<any>} The state of that session
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while retrieving session state.
   */
  getState(options?: OperationOptions): Promise<any>;

  /**
   * Sets the state on the Session. For more on session states, see
   * {@link https://docs.microsoft.com/en-us/azure/service-bus-messaging/message-sessions#message-session-state Session State}
   * @param state The state that needs to be set.
   * @param options - Options bag to pass an abort signal or tracing options.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while setting the session state.
   *
   * @param {*} state
   * @returns {Promise<void>}
   */
  setState(state: any, options?: OperationOptions): Promise<void>;
}

/**
 * @internal
 * @ignore
 */
export class SessionReceiverImpl<ReceivedMessageT extends ReceivedMessage | ReceivedMessageWithLock>
  implements SessionReceiver<ReceivedMessageT> {
  public entityPath: string;
  public sessionId: string;

  /**
   * @property {ClientEntityContext} _context Describes the amqp connection context for the QueueClient.
   */

  private _context: ClientEntityContext;
  private _retryOptions: RetryOptions;
  private _messageSession: MessageSession | undefined;
  /**
   * @property {boolean} [_isClosed] Denotes if close() was called on this receiver
   */
  private _isClosed: boolean = false;

  /**
   * @internal
   * @throws Error if the underlying connection is closed.
   * @throws Error if an open receiver is already existing for given sessionId.
   */
  private constructor(
    context: ClientEntityContext,
    public receiveMode: "peekLock" | "receiveAndDelete",
    private _sessionOptions: CreateSessionReceiverOptions,
    retryOptions: RetryOptions = {}
  ) {
    throwErrorIfConnectionClosed(context.namespace);
    this._context = context;
    this.entityPath = this._context.entityPath;
    this._retryOptions = retryOptions;

    if (this._sessionOptions.sessionId) {
      this._sessionOptions.sessionId = String(this._sessionOptions.sessionId);

      // Check if receiver for given session already exists
      if (
        this._context.messageSessions[this._sessionOptions.sessionId] &&
        this._context.messageSessions[this._sessionOptions.sessionId].isOpen()
      ) {
        const errorMessage = getOpenSessionReceiverErrorMsg(
          this._context.entityPath,
          this._sessionOptions.sessionId
        );
        const error = new Error(errorMessage);
        log.error(`[${this._context.namespace.connectionId}] %O`, error);
        throw error;
      }
    }

    // `createInitializedSessionReceiver` will set this value by calling init()
    // so we just temporarily set it to "" so we can get away with it never being
    // `undefined`.
    this.sessionId = "";
  }

  static async createInitializedSessionReceiver<
    ReceivedMessageT extends ReceivedMessage | ReceivedMessageWithLock
  >(
    context: ClientEntityContext,
    receiveMode: "peekLock" | "receiveAndDelete",
    sessionOptions: CreateSessionReceiverOptions,
    retryOptions: RetryOptions = {}
  ): Promise<SessionReceiver<ReceivedMessageT>> {
    const sessionReceiver = new SessionReceiverImpl<ReceivedMessageT>(
      context,
      receiveMode,
      sessionOptions,
      retryOptions
    );

    await sessionReceiver._createMessageSessionIfDoesntExist();
    return sessionReceiver;
  }

  private _throwIfReceiverOrConnectionClosed(): void {
    throwErrorIfConnectionClosed(this._context.namespace);
    if (this.isClosed) {
      const errorMessage = getReceiverClosedErrorMsg(
        this._context.entityPath,
        this._context.isClosed,
        this.sessionId!
      );
      const error = new Error(errorMessage);
      log.error(`[${this._context.namespace.connectionId}] %O`, error);
      throw error;
    }
  }

  private async _createMessageSessionIfDoesntExist(): Promise<void> {
    // TODO - pass timeout for MessageSession creation
    if (this._messageSession) {
      return;
    }
    this._context.isSessionEnabled = true;
    this._messageSession = await MessageSession.create(this._context, {
      sessionId: this._sessionOptions.sessionId,
      autoRenewLockDurationInMs: this._sessionOptions.autoRenewLockDurationInMs,
      receiveMode: convertToInternalReceiveMode(this.receiveMode)
    });
    // By this point, we should have a valid sessionId on the messageSession
    // If not, the receiver cannot be used, so throw error.
    if (this._messageSession.sessionId == null) {
      const error = new Error("Something went wrong. Cannot lock a session.");
      log.error(`[${this._context.namespace.connectionId}] %O`, error);
      throw error;
    }
    this.sessionId = this._messageSession.sessionId;
    delete this._context.expiredMessageSessions[this._messageSession.sessionId];
    return;
  }

  private _throwIfAlreadyReceiving(): void {
    if (this.isReceivingMessages()) {
      const errorMessage = getAlreadyReceivingErrorMsg(this._context.entityPath, this.sessionId);
      const error = new Error(errorMessage);
      log.error(`[${this._context.namespace.connectionId}] %O`, error);
      throw error;
    }
  }

  /**
   * @property Returns `true` if the receiver is closed. This can happen either because the receiver
   * itself has been closed or the client that created it has been closed.
   * @readonly
   */
  public get isClosed(): boolean {
    return (
      this._isClosed || (this.sessionId ? !this._context.messageSessions[this.sessionId] : false)
    );
  }

  /**
   * @property The time in UTC until which the session is locked.
   * Everytime `renewSessionLock()` is called, this time gets updated to current time plus the lock
   * duration as specified during the Queue/Subscription creation.
   *
   * Will return undefined until a AMQP receiver link has been successfully set up for the session.
   *
   * @readonly
   */
  public get sessionLockedUntilUtc(): Date | undefined {
    return this._messageSession ? this._messageSession.sessionLockedUntilUtc : undefined;
  }

  /**
   * Renews the lock on the session for the duration as specified during the Queue/Subscription
   * creation.
   * - Check the `sessionLockedUntilUtc` property on the SessionReceiver for the time when the lock expires.
   * - When the lock on the session expires
   *     - No more messages can be received using this receiver
   *     - If a message is not settled (using either `complete()`, `defer()` or `deadletter()`,
   *   before the session lock expires, then the message lands back in the Queue/Subscription for the next
   *   receive operation.
   *
   * @param options - Options bag to pass an abort signal or tracing options.
   * @returns Promise<Date> - New lock token expiry date and time in UTC format.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while renewing session lock.
   */
  async renewSessionLock(options?: OperationOptions): Promise<Date> {
    this._throwIfReceiverOrConnectionClosed();

    const renewSessionLockOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();
      this._messageSession!.sessionLockedUntilUtc = await this._context.managementClient!.renewSessionLock(
        this.sessionId,
        {
          ...options,
          requestName: "renewSessionLock",
          timeoutInMs: this._retryOptions.timeoutInMs
        }
      );
      return this._messageSession!.sessionLockedUntilUtc!;
    };
    const config: RetryConfig<Date> = {
      operation: renewSessionLockOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<Date>(config);
  }

  /**
   * Sets the state on the Session. For more on session states, see
   * {@link https://docs.microsoft.com/en-us/azure/service-bus-messaging/message-sessions#message-session-state Session State}
   * @param state The state that needs to be set.
   * @param options - Options bag to pass an abort signal or tracing options.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while setting the session state.
   */
  async setState(state: any, options: OperationOptions = {}): Promise<void> {
    this._throwIfReceiverOrConnectionClosed();

    const setSessionStateOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();
      await this._context.managementClient!.setSessionState(this.sessionId!, state, {
        ...options,
        requestName: "setState",
        timeoutInMs: this._retryOptions.timeoutInMs
      });
      return;
    };
    const config: RetryConfig<void> = {
      operation: setSessionStateOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<void>(config);
  }

  /**
   * Gets the state of the Session. For more on session states, see
   * {@link https://docs.microsoft.com/en-us/azure/service-bus-messaging/message-sessions#message-session-state Session State}
   * @param options - Options bag to pass an abort signal or tracing options.
   * @returns Promise<any> The state of that session
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while retrieving session state.
   */
  async getState(options: OperationOptions = {}): Promise<any> {
    this._throwIfReceiverOrConnectionClosed();

    const getSessionStateOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();
      return this._context.managementClient!.getSessionState(this.sessionId, {
        ...options,
        requestName: "getState",
        timeoutInMs: this._retryOptions.timeoutInMs
      });
    };
    const config: RetryConfig<any> = {
      operation: getSessionStateOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<any>(config);
  }

  async browseMessages(options: BrowseMessagesOptions = {}): Promise<ReceivedMessage[]> {
    this._throwIfReceiverOrConnectionClosed();

    const managementRequestOptions = {
      ...options,
      requestName: "browseMessages",
      timeoutInMs: this._retryOptions?.timeoutInMs
    };
    const peekOperationPromise = async () => {
      if (options.fromSequenceNumber) {
        return await this._context.managementClient!.peekBySequenceNumber(
          options.fromSequenceNumber,
          options.maxMessageCount,
          this.sessionId,
          managementRequestOptions
        );
      } else {
        return await this._context.managementClient!.peekMessagesBySession(
          this.sessionId,
          options.maxMessageCount,
          managementRequestOptions
        );
      }
    };

    const config: RetryConfig<ReceivedMessage[]> = {
      operation: peekOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<ReceivedMessage[]>(config);
  }

  /**
   * Returns a promise that resolves to a deferred message identified by the given `sequenceNumber`.
   * @param sequenceNumber The sequence number of the message that needs to be received.
   * @param options - Options bag to pass an abort signal or tracing options.
   * @returns Promise<ServiceBusMessage | undefined>
   * - Returns `Message` identified by sequence number.
   * - Returns `undefined` if no such message is found.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while receiving deferred message.
   */
  async receiveDeferredMessage(
    sequenceNumber: Long,
    options: OperationOptions = {}
  ): Promise<ReceivedMessageT | undefined> {
    this._throwIfReceiverOrConnectionClosed();
    throwTypeErrorIfParameterMissing(
      this._context.namespace.connectionId,
      "sequenceNumber",
      sequenceNumber
    );
    throwTypeErrorIfParameterNotLong(
      this._context.namespace.connectionId,
      "sequenceNumber",
      sequenceNumber
    );

    const receiveDeferredMessageOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();
      const messages = await this._context.managementClient!.receiveDeferredMessages(
        [sequenceNumber],
        convertToInternalReceiveMode(this.receiveMode),
        this.sessionId,
        {
          ...options,
          requestName: "receiveDeferredMessage",
          timeoutInMs: this._retryOptions.timeoutInMs
        }
      );
      return (messages[0] as unknown) as ReceivedMessageT;
    };
    const config: RetryConfig<ReceivedMessageT | undefined> = {
      operation: receiveDeferredMessageOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<ReceivedMessageT | undefined>(config);
  }

  /**
   * Returns a promise that resolves to an array of deferred messages identified by given `sequenceNumbers`.
   * @param sequenceNumbers An array of sequence numbers for the messages that need to be received.
   * @param options - Options bag to pass an abort signal or tracing options.
   * @returns Promise<ServiceBusMessage[]>
   * - Returns a list of messages identified by the given sequenceNumbers.
   * - Returns an empty list if no messages are found.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws MessagingError if the service returns an error while receiving deferred messages.
   */
  async receiveDeferredMessages(
    sequenceNumbers: Long[],
    options: OperationOptions = {}
  ): Promise<ReceivedMessageT[]> {
    this._throwIfReceiverOrConnectionClosed();
    throwTypeErrorIfParameterMissing(
      this._context.namespace.connectionId,
      "sequenceNumbers",
      sequenceNumbers
    );
    if (!Array.isArray(sequenceNumbers)) {
      sequenceNumbers = [sequenceNumbers];
    }
    throwTypeErrorIfParameterNotLongArray(
      this._context.namespace.connectionId,
      "sequenceNumbers",
      sequenceNumbers
    );

    const receiveDeferredMessagesOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();
      const deferredMessages = await this._context.managementClient!.receiveDeferredMessages(
        sequenceNumbers,
        convertToInternalReceiveMode(this.receiveMode),
        this.sessionId,
        {
          ...options,
          requestName: "receiveDeferredMessages",
          timeoutInMs: this._retryOptions.timeoutInMs
        }
      );
      return (deferredMessages as any) as ReceivedMessageT[];
    };
    const config: RetryConfig<ReceivedMessageT[]> = {
      operation: receiveDeferredMessagesOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.management,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<ReceivedMessageT[]>(config);
  }

  /**
   * Returns a promise that resolves to an array of messages based on given count and timeout over
   * an AMQP receiver link from a Queue/Subscription.
   *
   * The `maxWaitTimeInMs` provided via the options overrides the `timeoutInMs` provided in the `retryOptions`.
   * Throws an error if there is another receive operation in progress on the same receiver. If you
   * are not sure whether there is another receive operation running, check the `isReceivingMessages`
   * property on the receiver.
   *
   * @param maxMessageCount      The maximum number of messages to receive from Queue/Subscription.
   * @returns Promise<ServiceBusMessage[]> A promise that resolves with an array of Message objects.
   * @throws Error if the underlying connection or receiver is closed.
   * @throws Error if the receiver is already in state of receiving messages.
   * @throws MessagingError if the service returns an error while receiving messages.
   */
  async receiveBatch(
    maxMessageCount: number,
    options?: ReceiveBatchOptions
  ): Promise<ReceivedMessageT[]> {
    this._throwIfReceiverOrConnectionClosed();
    this._throwIfAlreadyReceiving();

    const receiveBatchOperationPromise = async () => {
      await this._createMessageSessionIfDoesntExist();

      const receivedMessages = await this._messageSession!.receiveMessages(
        maxMessageCount,
        options?.maxWaitTimeInMs ?? Constants.defaultOperationTimeoutInMs
      );

      return (receivedMessages as any) as ReceivedMessageT[];
    };
    const config: RetryConfig<ReceivedMessageT[]> = {
      operation: receiveBatchOperationPromise,
      connectionId: this._context.namespace.connectionId,
      operationType: RetryOperationType.receiveMessage,
      retryOptions: this._retryOptions,
      abortSignal: options?.abortSignal
    };
    return retry<ReceivedMessageT[]>(config);
  }

  subscribe(handlers: MessageHandlers<ReceivedMessageT>, options?: SubscribeOptions): void {
    // TODO - receiverOptions for subscribe??
    assertValidMessageHandlers(handlers);

    this._registerMessageHandler(
      async (message: ServiceBusMessageImpl) => {
        return handlers.processMessage((message as any) as ReceivedMessageT);
      },
      (err: Error) => {
        // TODO: not async internally yet.
        handlers.processError(err);
      },
      options
    );
  }

  /**
   * Registers handlers to deal with the incoming stream of messages over an AMQP receiver link
   * from a Queue/Subscription.
   * To stop receiving messages, call `close()` on the SessionReceiver.
   *
   * Throws an error if there is another receive operation in progress on the same receiver. If you
   * are not sure whether there is another receive operation running, check the `isReceivingMessages`
   * property on the receiver.
   *
   * @param onMessage - Handler for processing each incoming message.
   * @param onError - Handler for any error that occurs while receiving or processing messages.
   * @param options - Options to control whether messages should be automatically completed
   * or if the lock on the session should be automatically renewed. You can control the
   * maximum number of messages that should be concurrently processed. You can
   * also provide a timeout in milliseconds to denote the amount of time to wait for a new message
   * before closing the receiver.
   *
   * @returns void
   * @throws Error if the underlying connection or receiver is closed.
   * @throws Error if the receiver is already in state of receiving messages.
   * @throws MessagingErrormif the service returns an error while receiving messages. These are bubbled up to be handled by user provided `onError` handler.
   */
  private _registerMessageHandler(
    onMessage: OnMessage,
    onError: OnError,
    options?: SessionMessageHandlerOptions
  ): void {
    this._throwIfReceiverOrConnectionClosed();
    this._throwIfAlreadyReceiving();
    const connId = this._context.namespace.connectionId;
    throwTypeErrorIfParameterMissing(connId, "onMessage", onMessage);
    throwTypeErrorIfParameterMissing(connId, "onError", onError);
    if (typeof onMessage !== "function") {
      throw new TypeError("The parameter 'onMessage' must be of type 'function'.");
    }
    if (typeof onError !== "function") {
      throw new TypeError("The parameter 'onError' must be of type 'function'.");
    }

    this._createMessageSessionIfDoesntExist()
      .then(async () => {
        if (!this._messageSession) {
          return;
        }
        if (!this._isClosed) {
          this._messageSession.receive(onMessage, onError, options);
        } else {
          await this._messageSession.close();
        }
        return;
      })
      .catch((err) => {
        onError(err);
      });
  }

  /**
   * Gets an async iterator over messages from the receiver.
   *
   * The `maxWaitTimeInMs` provided via the options overrides the `timeoutInMs` provided in the `retryOptions`.
   * Throws an error if there is another receive operation in progress on the same receiver. If you
   * are not sure whether there is another receive operation running, check the `isReceivingMessages`
   * property on the receiver.
   *
   * If the iterator is not able to fetch a new message in over a minute, `undefined` will be returned.
   * @throws Error if the underlying connection, client or receiver is closed.
   * @throws Error if current receiver is already in state of receiving messages.
   * @throws MessagingError if the service returns an error while receiving messages.
   */
  getMessageIterator(options?: GetMessageIteratorOptions): AsyncIterableIterator<ReceivedMessageT> {
    return getMessageIterator(this, options);
  }

  /**
   * Closes the underlying AMQP receiver link.
   * Once closed, the receiver cannot be used for any further operations.
   * Use the `createReceiver` function on the QueueClient or SubscriptionClient to instantiate
   * a new Receiver
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    try {
      if (this._messageSession) {
        await this._messageSession.close();
        this._messageSession = undefined;
      }
    } catch (err) {
      log.error(
        "[%s] An error occurred while closing the SessionReceiver for session %s in %s: %O",
        this._context.namespace.connectionId,
        this.sessionId,
        this._context.entityPath,
        err
      );
      throw err;
    } finally {
      this._isClosed = true;
    }
  }

  /**
   * Indicates whether the receiver is currently receiving messages or not.
   * When this returns true, new `registerMessageHandler()` or `receiveMessages()` calls cannot be made.
   */
  isReceivingMessages(): boolean {
    return this._messageSession ? this._messageSession.isReceivingMessages : false;
  }
}
