import { GameConfig } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { math } from "../../../../shared/utils/math";
import { util } from "../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Player } from "../objects/player";
import type { BotBrainType } from "./botBrain";
import type { BotDifficulty } from "./botDifficulty";
import type { BotBrain } from "./brains/botBrainLogic";
import { CompetitiveBotBrain } from "./brains/competitiveBotBrain";
import { PracticeBotBrain } from "./brains/practiceBotBrain";
import { RealisticBotBrain } from "./brains/realisticBotBrain";
import { BotAimController } from "./systems/botAimController";
import { BotNavigationLite } from "./systems/botNavigationLite";
import { BotPerception } from "./systems/botPerception";
import { BotWeaponLogic } from "./systems/botWeaponLogic";

export class BotController {
    private _time = 0;
    private _seq = 0;
    private _decisionTicker = 0;

    private readonly _perception = new BotPerception();
    private readonly _navigation = new BotNavigationLite();
    private readonly _aim: BotAimController;
    private readonly _weaponLogic: BotWeaponLogic;
    private readonly _brain: BotBrain;

    private _lastPos: Vec2;
    private _lastMovedTime = 0;

    constructor(
        readonly game: Game,
        readonly player: Player,
        readonly difficulty: BotDifficulty,
        readonly brainType: BotBrainType = "realistic",
    ) {
        this._lastPos = v2.copy(player.pos);
        this._aim = new BotAimController(player, difficulty);
        this._weaponLogic = new BotWeaponLogic(difficulty);
        this._brain = this._createBrain(brainType);
    }

    /**
     * True when bot has seen an enemy recently (used for retire priority).
     */
    get inCombat(): boolean {
        return this._perception.inCombat(this._time);
    }

    /**
     * Seconds since bot last moved significantly (used for retire priority).
     */
    get secondsSinceMove(): number {
        return this._time - this._lastMovedTime;
    }

    update(dt: number): void {
        this._time += dt;

        const player = this.player;
        if (player.dead || player.downed || player.disconnected) {
            return;
        }

        this._navigation.tick(dt, this._perception.targetId !== undefined);

        const movedDist = v2.distance(player.pos, this._lastPos);
        if (movedDist > 0.5) {
            this._lastPos = v2.copy(player.pos);
            this._lastMovedTime = this._time;
        }

        const decisionInterval = 1 / math.max(Config.bots.decisionTps, 1);
        this._decisionTicker += dt;
        if (this._decisionTicker >= decisionInterval) {
            this._decisionTicker %= decisionInterval;
            this._brain.decide({
                game: this.game,
                player: this.player,
                difficulty: this.difficulty,
                timeNow: this._time,
                perception: this._perception,
                navigation: this._navigation,
                aim: this._aim,
                weaponLogic: this._weaponLogic,
            });
        }

        const msg = this._buildInput(dt);
        player.handleInput(msg);
    }

    private _createBrain(type: BotBrainType): BotBrain {
        switch (type) {
            case "practice":
                return new PracticeBotBrain();
            case "competitive":
                return new CompetitiveBotBrain();
            case "realistic":
            default:
                return new RealisticBotBrain();
        }
    }

    private _buildInput(dt: number): net.InputMsg {
        const player = this.player;

        const msg = new net.InputMsg();
        msg.seq = this._seq++ % 256;

        const targetObj = this._perception.targetId
            ? this.game.objectRegister.getById(this._perception.targetId)
            : undefined;
        const target =
            targetObj && targetObj.__type === ObjectType.Player
                ? (targetObj as Player)
                : undefined;
        const validTarget =
            target &&
            !target.dead &&
            !target.disconnected &&
            util.sameLayer(target.layer, player.layer)
                ? target
                : undefined;

        if (!validTarget) {
            this._perception.targetId = undefined;
            this._perception.targetVisible = false;
        }

        const gas = this.game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const goal = this._navigation.getGoal(
            this.game,
            player,
            gasEmergency,
            validTarget?.pos,
        );

        const { gunDef, weaponClass, profile } = this._weaponLogic.getWeaponInfo(player);

        this._weaponLogic.decrementTimers(dt);

        const aimUpdate = this._aim.update(dt, {
            player,
            goal,
            target: validTarget,
            gunDef,
        });

        msg.toMouseLen = math.clamp(aimUpdate.aimLen, 0, net.Constants.MouseMaxDist);

        this._navigation.applyMovementInput({
            msg,
            player,
            goal,
            hasTarget: !!validTarget,
            gasEmergency,
            aimDir: aimUpdate.aimDir,
            dt,
        });

        // Precision "stop to shoot" focus time
        const standStillForPrecision =
            !!validTarget &&
            !!profile?.stopToShoot &&
            weaponClass === "precision" &&
            this._perception.targetVisible &&
            aimUpdate.distToTarget >= profile.idealMin &&
            aimUpdate.distToTarget <= profile.idealMax &&
            this._time >= this._weaponLogic.nextShootTime &&
            aimUpdate.angleDeltaDeg <= profile.aimGateDeg * 2;

        if (standStillForPrecision) {
            msg.moveLeft = false;
            msg.moveRight = false;
            msg.moveUp = false;
            msg.moveDown = false;
            this._aim.focusTime += dt;
        } else {
            this._aim.focusTime = 0;
        }

        // Use items
        msg.useItem = "";
        if (!player.downed && player.actionType === GameConfig.Action.None) {
            if (player.health < 60) {
                if (player.inventory["healthkit"] > 0) msg.useItem = "healthkit";
                else if (player.inventory["bandage"] > 0) msg.useItem = "bandage";
            } else if (player.boost < 40) {
                if (player.inventory["painkiller"] > 0) msg.useItem = "painkiller";
                else if (player.inventory["soda"] > 0) msg.useItem = "soda";
            }
        }

        const burst = this._weaponLogic.updateBurstTimers({
            dt,
            hasTarget: !!validTarget,
            distToTarget: aimUpdate.distToTarget,
            profile,
        });

        const allowShooting = this._weaponLogic.allowShooting({
            timeNow: this._time,
            hasTarget: !!validTarget,
            targetVisible: this._perception.targetVisible,
            gasEmergency,
            distToTarget: aimUpdate.distToTarget,
            angleDeltaDeg: aimUpdate.angleDeltaDeg,
            focusTime: this._aim.focusTime,
            weaponClass,
            profile,
            burstGateOk: burst.burstGateOk,
        });

        this._weaponLogic.applyShootInputs({
            msg,
            allowShooting,
            gunDef,
            profile,
        });

        const shot = this._weaponLogic.computeWillShootThisTick({
            dt,
            msg,
            player,
            gunDef,
        });

        this._weaponLogic.updateBloomAndPostShot({
            dt,
            willShootThisTick: shot.willShootThisTick,
            startingBurstThisTick: shot.startingBurstThisTick,
            gunDef,
            weaponClass,
            profile,
        });

        const movingThisTick = msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown;
        const noiseDeg = this._weaponLogic.computeShotNoiseDeg({
            willShootThisTick: shot.willShootThisTick,
            profile,
            weaponClass,
            movingThisTick,
        });

        msg.toMouseDir = this._aim.getDirWithNoiseDeg(noiseDeg);

        this._weaponLogic.applyQuickswitch({
            msg,
            player,
            difficulty: this.difficulty,
            burstHoldT: this._weaponLogic.burstHoldT,
        });

        // Ensure internal bots behave like mobile for auto doors/pickup
        msg.touchMoveActive = false;

        return msg;
    }
}

export type { BotDifficulty } from "./botDifficulty";

