/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */

import {
    BotFrameworkAdapter,
    BotTelemetryClient,
    RecognizerResult,
    StatePropertyAccessor,
    TurnContext} from 'botbuilder';
import { LuisRecognizer, LuisRecognizerTelemetryClient, QnAMakerResult, QnAMakerTelemetryClient } from 'botbuilder-ai';
import {
    ComponentDialog,
    ConfirmPrompt,
    DialogContext,
    DialogSet,
    DialogTurnResult,
    DialogTurnStatus,
    OAuthPrompt,
    WaterfallDialog,
    WaterfallStepContext} from 'botbuilder-dialogs';
import {
    ISkillManifest,
    SkillContext,
    SkillDialog,
    SkillRouter } from 'botbuilder-skills';
import {
    ICognitiveModelSet,
    InterruptionAction,
    TokenEvents } from 'botbuilder-solutions';
import { TokenStatus } from 'botframework-connector';
import {
    Activity,
    ActivityTypes } from 'botframework-schema';
import i18next from 'i18next';
import { IOnboardingState } from '../models/onboardingState';
import { CancelResponses } from '../responses/cancelResponses';
import { MainResponses } from '../responses/mainResponses';
import { BotServices } from '../services/botServices';
import { IBotSettings } from '../services/botSettings';
import { CancelDialog } from './cancelDialog';
import { EscalateDialog } from './escalateDialog';
import { OnboardingDialog } from './onboardingDialog';

enum Events {
    timeZoneEvent = 'va.timeZone',
    locationEvent = 'va.location'
}

export class MainDialog extends ComponentDialog {
    // Fields
    private readonly luisServiceGeneral: string = 'general';
    private readonly luisServiceFaq: string = 'faq';
    private readonly luisServiceChitchat: string = 'chitchat';
    private readonly settings: Partial<IBotSettings>;
    private readonly services: BotServices;
    private readonly skillContextAccessor: StatePropertyAccessor<SkillContext>;
    private readonly onboardingAccessor: StatePropertyAccessor<IOnboardingState>;
    private readonly responder: MainResponses = new MainResponses();

    // Constructor
    public constructor(
        settings: Partial<IBotSettings>,
        services: BotServices,
        onboardingDialog: OnboardingDialog,
        escalateDialog: EscalateDialog,
        cancelDialog: CancelDialog,
        skillDialogs: SkillDialog[],
        skillContextAccessor: StatePropertyAccessor<SkillContext>,
        onboardingAccessor: StatePropertyAccessor<IOnboardingState>,
        telemetryClient: BotTelemetryClient
    ) {
        super(MainDialog.name); //, telemetryClient);
        this.settings = settings;
        this.services = services;
        this.onboardingAccessor = onboardingAccessor;
        this.skillContextAccessor = skillContextAccessor;
        this.telemetryClient = telemetryClient;

        this.addDialog(onboardingDialog);
        this.addDialog(escalateDialog);
        this.addDialog(cancelDialog);

        skillDialogs.forEach((skillDialog: SkillDialog): void => {
            this.addDialog(skillDialog);
        });

        this.addDialog(new OAuthPrompt('OAuthPrompt', {
            connectionName: 'Outlook',
            text: 'Please Sign In',
            title: 'Sign In',
            timeout: 300000
        }));
        this.addDialog(new ConfirmPrompt('ConfirmPrompt'));
        this.addDialog(new WaterfallDialog('MainWaterfallDialog', [
            this.promptStep.bind(this),
            this.loginStep.bind(this),
            this.displayTokenPhase1.bind(this),
            this.displayTokenPhase2.bind(this)
        ]));

        this.initialDialogId = 'MainWaterfallDialog';
    }

    public async promptStep(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        return stepContext.beginDialog('OAuthPrompt');
    }

    public async loginStep(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        // Get the token from the previous step. Note that we could also have gotten the
        // token directly from the prompt itself. There is an example of this in the next method.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
        const tokenResponse: any = stepContext.result;
        if (tokenResponse) {
            await stepContext.context.sendActivity('You are now logged in.');

            return stepContext.prompt('ConfirmPrompt', 'Would you like to view your token?');
        }
        await stepContext.context.sendActivity('Login was not successful please try again.');

        return stepContext.endDialog();
    }

    public async displayTokenPhase1(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        await stepContext.context.sendActivity('Thank you.');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
        const result: any = stepContext.result;
        if (result) {
            // Call the prompt again because we need the token. The reasons for this are:
            // 1. If the user is already logged in we do not need to store the token locally in the bot and worry
            // about refreshing it. We can always just call the prompt again to get the token.
            // 2. We never know how long it will take a user to respond. By the time the
            // user responds the token may have expired. The user would then be prompted to login again.
            //
            // There is no reason to store the token locally in the bot because we can always just call
            // the OAuth prompt to get the token or get a new token if needed.
            return stepContext.beginDialog('OAuthPrompt');
        }

        return stepContext.endDialog();
    }

    public async displayTokenPhase2(stepContext: WaterfallStepContext): Promise<DialogTurnResult> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
        const tokenResponse: any = stepContext.result;
        if (tokenResponse) {
            // tslint:disable-next-line:no-unsafe-any
            await stepContext.context.sendActivity(`Here is your token ${ tokenResponse.token }`);
        }

        return stepContext.endDialog();
    }

    protected async onStart(dc: DialogContext): Promise<void> {
        const view: MainResponses = new MainResponses();
        const onboardingState: IOnboardingState|undefined = await this.onboardingAccessor.get(dc.context);
        if (onboardingState === undefined || onboardingState.name === undefined || onboardingState.name === '') {
            await view.replyWith(dc.context, MainResponses.responseIds.newUserGreeting);
        } else {
            await view.replyWith(dc.context, MainResponses.responseIds.returningUserGreeting);
        }
    }

    protected async route(dc: DialogContext): Promise<void> {
        const cognitiveModels: ICognitiveModelSet = this.services.getCognitiveModel();

        // Check dispatch result
        const dispatchResult: RecognizerResult = await cognitiveModels.dispatchService.recognize(dc.context);
        const intent: string = LuisRecognizer.topIntent(dispatchResult);

        if (this.settings.skills === undefined) {
            throw new Error('There is no skills in settings value');
        }
        // Identify if the dispatch intent matches any Action within a Skill if so, we pass to the appropriate SkillDialog to hand-off
        const identifiedSkill: ISkillManifest | undefined = SkillRouter.isSkill(this.settings.skills, intent);
        if (identifiedSkill !== undefined) {
            // We have identified a skill so initialize the skill connection with the target skill
            const result: DialogTurnResult = await dc.beginDialog(identifiedSkill.id);

            if (result.status === DialogTurnStatus.complete) {
                await this.complete(dc);
            }
        } else if (intent === 'l_general') {
            // If dispatch result is general luis model
            const luisService: LuisRecognizerTelemetryClient | undefined = cognitiveModels.luisServices.get(this.luisServiceGeneral);
            if (luisService === undefined) {
                throw new Error('The specified LUIS Model could not be found in your Bot Services configuration.');
            } else {
                const result: RecognizerResult = await luisService.recognize(dc.context);
                if (result !== undefined) {
                    const generalIntent: string = LuisRecognizer.topIntent(result);

                    // switch on general intents
                    switch (generalIntent) {
                        case 'Escalate': {
                            // start escalate dialog
                            await dc.beginDialog(EscalateDialog.name);
                            break;
                        }
                        case 'None':
                        default: {
                            // No intent was identified, send confused message
                            await this.responder.replyWith(dc.context, MainResponses.responseIds.confused);
                        }
                    }
                }
            }
        } else if (intent === 'q_faq') {
            const qnaService: QnAMakerTelemetryClient | undefined = cognitiveModels.qnaServices.get(this.luisServiceFaq);

            if (qnaService === undefined) {
                throw new Error('The specified QnA Maker Service could not be found in your Bot Services configuration.');
            } else {
                const answers: QnAMakerResult[] = await qnaService.getAnswers(dc.context);
                if (answers !== undefined && answers.length > 0) {
                    await dc.context.sendActivity(answers[0].answer, answers[0].answer);
                } else {
                    await this.responder.replyWith(dc.context, MainResponses.responseIds.confused);
                }
            }
        } else if (intent === 'q_chitchat') {
            const qnaService: QnAMakerTelemetryClient | undefined = cognitiveModels.qnaServices.get(this.luisServiceChitchat);

            if (qnaService === undefined) {
                throw new Error('The specified QnA Maker Service could not be found in your Bot Services configuration.');
            } else {
                const answers: QnAMakerResult[] = await qnaService.getAnswers(dc.context);
                if (answers !== undefined && answers.length > 0) {
                    await dc.context.sendActivity(answers[0].answer, answers[0].answer);
                } else {
                    await this.responder.replyWith(dc.context, MainResponses.responseIds.confused);
                }
            }
        } else {
            // If dispatch intent does not map to configured models, send 'confused' response.
            await this.responder.replyWith(dc.context, MainResponses.responseIds.confused);
        }
    }

    protected async onEvent(dc: DialogContext): Promise<void> {
        // Check if there was an action submitted from intro card
        if (dc.context.activity.value) {
            // tslint:disable-next-line: no-unsafe-any
            if (dc.context.activity.value.action === 'startOnboarding') {
                await dc.beginDialog(OnboardingDialog.name);

                return;
            }
        }

        let forward: boolean = true;
        const ev: Activity = dc.context.activity;
        if (ev.name !== undefined && ev.name.trim().length > 0) {
            switch (ev.name) {
                case Events.timeZoneEvent: {
                    try {
                        const timezone: string = ev.value as string;
                        const tz: string = new Date().toLocaleString(timezone);
                        const timeZoneObj: {
                            timezone: string;
                        } = {
                            timezone: tz
                        };

                        const skillContext: SkillContext = await this.skillContextAccessor.get(dc.context, new SkillContext());
                        skillContext.setObj(timezone, timeZoneObj);

                        await this.skillContextAccessor.set(dc.context, skillContext);
                    } catch {
                        await dc.context.sendActivity(
                            {
                                type: ActivityTypes.Trace,
                                text: `"Timezone passed could not be mapped to a valid Timezone. Property not set."`
                            }
                        );
                    }
                    forward = false;
                    break;
                }
                case Events.locationEvent: {
                    const location: string = ev.value as string;
                    const locationObj: {
                        location: string;
                    } = {
                        location: location
                    };

                    const skillContext: SkillContext = await this.skillContextAccessor.get(dc.context, new SkillContext());
                    skillContext.setObj(location, locationObj);

                    await this.skillContextAccessor.set(dc.context, skillContext);

                    forward = true;
                    break;
                }
                case TokenEvents.tokenResponseEventName: {
                    forward = true;
                    break;
                }
                default: {
                    await dc.context.sendActivity(
                        {
                            type: ActivityTypes.Trace,
                            text: `"Unknown Event ${ ev.name } was received but not processed."`
                        }
                    );
                    forward = false;
                }
            }
        }

        if (forward) {
            const result: DialogTurnResult = await dc.continueDialog();

            if (result.status === DialogTurnStatus.complete) {
                await this.complete(dc);
            }
        }
    }

    protected async complete(dc: DialogContext, result?: DialogTurnResult): Promise<void> {
        // The active dialog's stack ended with a complete status
        await this.responder.replyWith(dc.context, MainResponses.responseIds.completed);
    }

    protected async onInterruptDialog(dc: DialogContext): Promise<InterruptionAction> {
        if (dc.context.activity.type === ActivityTypes.Message) {
            const cognitiveModels: ICognitiveModelSet = this.services.getCognitiveModel();

            // check luis intent
            const luisService: LuisRecognizerTelemetryClient | undefined = cognitiveModels.luisServices.get(this.luisServiceGeneral);

            if (luisService === undefined) {
                throw new Error('The general LUIS Model could not be found in your Bot Services configuration.');
            } else {
                const luisResult: RecognizerResult = await luisService.recognize(dc.context);
                const intent: string = LuisRecognizer.topIntent(luisResult);

                // Only triggers interruption if confidence level is high
                if (luisResult.intents[intent] !== undefined && luisResult.intents[intent].score > 0.5) {
                    switch (intent) {
                        case 'Cancel': {
                            return this.onCancel(dc);
                        }
                        case 'Help': {
                            return this.onHelp(dc);
                        }
                        case 'Logout': {
                            return this.onLogout(dc);
                        }
                        default:
                    }
                }
            }
        }

        return InterruptionAction.NoAction;
    }

    private async onCancel(dc: DialogContext): Promise<InterruptionAction> {
        if (dc.activeDialog !== undefined && dc.activeDialog.id !== CancelDialog.name) {
            // Don't start restart cancel dialog
            await dc.beginDialog(CancelDialog.name);

            // Signal that the dialog is waiting on user response
            return InterruptionAction.StartedDialog;
        }

        const view: CancelResponses = new CancelResponses();
        await view.replyWith(dc.context, CancelResponses.responseIds.nothingToCancelMessage);

        return InterruptionAction.StartedDialog;
    }

    private async onHelp(dc: DialogContext): Promise<InterruptionAction> {
        await this.responder.replyWith(dc.context, MainResponses.responseIds.help);

        // Signal the conversation was interrupted and should immediately continue
        return InterruptionAction.MessageSentToUser;
    }

    private async onLogout(dc: DialogContext): Promise<InterruptionAction> {
        let adapter: BotFrameworkAdapter;
        const supported: boolean = dc.context.adapter instanceof BotFrameworkAdapter;
        if (!supported) {
            throw new Error('OAuthPrompt.SignOutUser(): not supported by the current adapter');
        } else {
            adapter = dc.context.adapter as BotFrameworkAdapter;
        }

        await dc.cancelAllDialogs();

        // Sign out user
        // PENDING check adapter.getTokenStatusAsync
        const tokens: TokenStatus[] = [];
        tokens.forEach(async (token: TokenStatus): Promise<void> => {
            if (token.connectionName !== undefined) {
                await adapter.signOutUser(dc.context, token.connectionName);
            }
        });
        await dc.context.sendActivity(i18next.t('main.logOut'));

        return InterruptionAction.StartedDialog;
    }

    public async run(context: TurnContext, accessor: StatePropertyAccessor): Promise<void> {
        const dialogSet: DialogSet = new DialogSet(accessor);
        dialogSet.add(this);

        const dialogContext: DialogContext = await dialogSet.createContext(context);
        const results: DialogTurnResult = await dialogContext.continueDialog();
        if (results.status === DialogTurnStatus.empty) {
            await dialogContext.beginDialog(this.id);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
    public async onBeginDialog(innerDc: DialogContext, options?: any): Promise<DialogTurnResult> {
        const result: DialogTurnResult = await this.interrupt(innerDc);
        if (result.result !== undefined) {
            return result;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
        return super.onBeginDialog(innerDc, options);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
    public async onContinueDialog(innerDc: DialogContext): Promise<DialogTurnResult> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
        const result: DialogTurnResult = await this.interrupt(innerDc);
        if (result.result !== undefined) {
            return result;
        }

        return super.onContinueDialog(innerDc);
    }

    public async interrupt(innerDc: DialogContext): Promise<DialogTurnResult> {
        if (innerDc.context.activity.type === ActivityTypes.Message) {
            const text: string = innerDc.context.activity.text.toLowerCase();
            if (text === 'logout') {
                // The bot adapter encapsulates the authentication processes.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
                const botAdapter: any = innerDc.context.adapter;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/tslint/config
                await botAdapter.signOutUser(innerDc.context, 'Outlook');
                await innerDc.context.sendActivity('You have been signed out.');

                return innerDc.cancelAllDialogs();
            }

            return innerDc.cancelAllDialogs();
        }

        return innerDc.cancelAllDialogs();
    }
}
