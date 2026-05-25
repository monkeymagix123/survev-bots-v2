import { GameConfig } from "../../../../../shared/gameConfig";
import { ObjectType } from "../../../../../shared/net/objectSerializeFns";
import { coldet } from "../../../../../shared/utils/coldet";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers";
import { math } from "../../../../../shared/utils/math";
import { util } from "../../../../../shared/utils/util";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import { Config } from "../../../config";
import {
    type BotUnarmedThreatContext,
    computeBotDanger,
} from "../botDecisionSupport";
import { logBotCombat } from "../botCombatLogger";
import { logBotStability } from "../botStabilityLogger";
import { BotTuning } from "../botTuning";
import type { BotBrain, BotBrainContext } from "./botBrainLogic";

export class UnarmedBotBrain implements BotBrain {
    readonly type = "realistic" as const;

    decide(ctx: BotBrainContext): void {
        const {
            brainType,
            brainProfile,
            game,
            player,
            timeNow,
            perception,
            navigation,
            lootScorer,
            objectInteractionScorer,
            combat,
            aim,
        } = ctx;

        const scan = perception.scanForTarget(game, player, timeNow, brainType);
        const recentlyDamaged =
            timeNow - combat.lastDamagedTime < BotTuning.combat.recentlyDamagedWindowSec;
        const threat = perception.threat;
        const enemyVeryClose =
            threat.nearestNearbyHostileDist < BotTuning.combat.enemyVeryCloseDist;
        const actionableTarget =
            scan.target && (scan.visible || enemyVeryClose || recentlyDamaged)
                ? scan.target
                : undefined;

        const prevTargetId = perception.targetId;
        const prevVisible = perception.targetVisible;

        if (actionableTarget) {
            const newTargetId = actionableTarget.__id;
            const newVisible = scan.visible;

            perception.targetId = newTargetId;
            perception.targetVisible = newVisible;

            if (prevTargetId !== newTargetId) {
                aim.resetFocus();
                perception.lastSeenPos = undefined;
                perception.lastSeenTime = -Infinity;
            }

            if (newVisible) {
                perception.markTargetVisible(timeNow, actionableTarget.pos);
            }
        } else {
            perception.targetId = undefined;
            perception.targetVisible = false;
            perception.lastSeenPos = undefined;
            perception.lastSeenTime = -Infinity;
            perception.targetHasShownGun = false;
            perception.targetAppearsUnarmed = false;
            perception.targetRecentlyFired = false;
            perception.targetDistracted = false;
            aim.resetFocus();
        }

        const prevState = combat.state;
        const prevObjectTargetId = combat.objectTargetId;
        const prevObjectInteractionMode = combat.objectInteractionMode;
        const prevObjectGoal = combat.goalPos ? v2.copy(combat.goalPos) : undefined;
        const gas = game.gas;
        const gasEmergency = gas.isInGas(player.pos) || gas.isOutSideSafeZone(player.pos);

        const sanitizeGoal = (pos: { x: number; y: number }) => {
            let goal = v2.copy(pos);
            game.map.clampToMapBounds(goal);

            const delta = v2.sub(goal, gas.posNew);
            const dist = v2.length(delta);
            const maxDist = Math.max(gas.radNew - 2, 0);
            if (dist > maxDist && maxDist > 0) {
                const dir = v2.normalizeSafe(delta, v2.create(1, 0));
                goal = v2.add(gas.posNew, v2.mul(dir, maxDist));
                game.map.clampToMapBounds(goal);
            }

            if (game.map.isOnWater(goal, 0)) {
                goal = v2.lerp(0.5, goal, game.gas.posNew);
                game.map.clampToMapBounds(goal);
            }

            return goal;
        };

        const visibleHostile = !!actionableTarget && scan.visible;
        const threatContext: BotUnarmedThreatContext = {
            visibleHostile,
            hostileHasShownGun: visibleHostile && perception.targetHasShownGun,
            hostileAppearsUnarmed: visibleHostile && perception.targetAppearsUnarmed,
            hostileRecentlyFired: visibleHostile && perception.targetRecentlyFired,
            hostileDistracted: visibleHostile && perception.targetDistracted,
            hostilePos: visibleHostile ? v2.copy(actionableTarget!.pos) : undefined,
        };

        if (actionableTarget) {
            combat.unarmedThreatPos = v2.copy(actionableTarget.pos);
        }
        if (recentlyDamaged) {
            combat.unarmedPressureUntil = Math.max(
                combat.unarmedPressureUntil,
                timeNow + BotTuning.unarmed.recentDamageResumeSec,
            );
        } else if (visibleHostile || enemyVeryClose) {
            combat.unarmedPressureUntil = Math.max(
                combat.unarmedPressureUntil,
                timeNow + BotTuning.unarmed.recentPressureResumeSec,
            );
        }
        const underRecentPressure = timeNow < combat.unarmedPressureUntil;

        const lowHp = player.health < BotTuning.heal.lowHp;
        const baseDanger = computeBotDanger({
            targetVisible: visibleHostile,
            hasTarget: !!actionableTarget,
            distToTarget: actionableTarget
                ? v2.distance(player.pos, actionableTarget.pos)
                : BotTuning.danger.distanceRef,
            lowHp,
            needsReload: false,
            isReloading: false,
            recentlyDamaged,
            gasEmergency,
        });
        let danger = baseDanger;
        if (threatContext.hostileHasShownGun) {
            danger += BotTuning.unarmed.shownGunDangerAdd;
            if (threatContext.hostileDistracted) {
                danger -= BotTuning.unarmed.distractedArmedDangerRelief;
            }
        } else if (threatContext.hostileAppearsUnarmed) {
            danger -= BotTuning.unarmed.visibleUnarmedDangerDiscount;
        }
        danger = math.clamp(danger, 0, 1);

        navigation.ensureWaypoint(game, player);

        const immediateGun = !gasEmergency
            ? lootScorer.chooseLoot({
                  game,
                  player,
                  timeNow,
                  mode: "idle",
                  brainType,
                  onlyGuns: true,
                  unarmedThreat: threatContext,
              })
            : undefined;

        const canFarmObjects =
            !gasEmergency &&
            !underRecentPressure &&
            !recentlyDamaged &&
            (!visibleHostile ||
                threatContext.hostileAppearsUnarmed ||
                threatContext.hostileDistracted);
        const objectGoal = canFarmObjects
            ? objectInteractionScorer.chooseObject({
                  game,
                  player,
                  timeNow,
                  mode: "idle",
                  brainType,
                  state: "wander",
                  baseGoal: immediateGun?.pos ?? navigation.waypoint,
                  unarmedThreat: threatContext,
              })
            : undefined;
        const fallbackLoot =
            !immediateGun &&
            !objectGoal &&
            !gasEmergency &&
            !underRecentPressure &&
            (!visibleHostile ||
                threatContext.hostileAppearsUnarmed ||
                threatContext.hostileDistracted)
                ? lootScorer.chooseLoot({
                      game,
                      player,
                      timeNow,
                      mode: "idle",
                      brainType,
                      unarmedThreat: threatContext,
                  })
                : undefined;

        type State = typeof combat.state;
        let state: State = "wander";
        let reason = "unarmed_default";

        if (lowHp && danger >= brainProfile.retreatDangerMin) {
            state = "seek_cover";
            reason = "unarmed_low_hp";
        } else if (
            visibleHostile &&
            threatContext.hostileHasShownGun &&
            !threatContext.hostileDistracted
        ) {
            state = danger >= brainProfile.highDangerMin ? "seek_cover" : "back_off";
            reason = "unarmed_visible_gun";
        } else if (recentlyDamaged) {
            state = danger >= brainProfile.highDangerMin ? "seek_cover" : "back_off";
            reason = "unarmed_recent_damage";
        } else if (enemyVeryClose) {
            state = "back_off";
            reason = threatContext.hostileAppearsUnarmed
                ? "unarmed_melee_pressure"
                : "unarmed_enemy_close";
        } else if (immediateGun) {
            state = "loot";
            reason = "unarmed_find_gun";
        } else if (objectGoal) {
            state = "interact_object";
            reason = objectGoal.reason;
        } else if (fallbackLoot) {
            state = "loot";
            reason = fallbackLoot.reason;
        } else if (visibleHostile && threatContext.hostileAppearsUnarmed) {
            state = "back_off";
            reason = "unarmed_visible_melee_disengage";
        } else if (underRecentPressure && combat.unarmedThreatPos) {
            state = lowHp || danger >= brainProfile.highDangerMin ? "seek_cover" : "back_off";
            reason = "unarmed_recent_pressure";
        } else {
            state = "wander";
            reason = "unarmed_seek_object";
        }

        const stateLocked = timeNow < combat.stateLockUntil;
        if (stateLocked) {
            const canPreserveFarmState =
                !underRecentPressure &&
                !recentlyDamaged &&
                (!visibleHostile ||
                    threatContext.hostileAppearsUnarmed ||
                    threatContext.hostileDistracted);

            if (
                prevState === "loot" &&
                canPreserveFarmState &&
                combat.lootTargetId !== undefined &&
                state !== "seek_cover" &&
                state !== "back_off"
            ) {
                state = prevState;
                reason = combat.stateReason;
            } else if (
                prevState === "interact_object" &&
                canPreserveFarmState &&
                combat.objectTargetId !== undefined &&
                state !== "seek_cover" &&
                state !== "back_off"
            ) {
                state = prevState;
                reason = combat.stateReason;
            }
        }

        const stateChanged = prevState !== state;
        combat.setState(state, timeNow, reason);
        if (stateChanged) {
            switch (state) {
                case "seek_cover":
                    combat.stateLockUntil =
                        timeNow + BotTuning.combat.retreatStateCommitSec;
                    break;
                case "loot":
                    combat.stateLockUntil = timeNow + BotTuning.combat.lootStateCommitSec;
                    break;
                case "interact_object":
                    combat.stateLockUntil =
                        timeNow + BotTuning.objectInteract.stateCommitSec;
                    break;
                default:
                    combat.stateLockUntil = timeNow;
                    break;
            }
        }

        const retreatPointFrom = (source: { x: number; y: number }, retreatDist: number) => {
            const enteringRetreat =
                stateChanged && (state === "seek_cover" || state === "back_off");
            if (enteringRetreat || timeNow > combat.evadeUntil) {
                combat.evadeAwayFrac = util.random(0.6, 0.8);
                combat.evadePerpSign = Math.random() < 0.5 ? -1 : 1;
                combat.evadeUntil = timeNow + util.random(0.5, 1.0);
            }

            const away = v2.normalizeSafe(v2.sub(player.pos, source), v2.randomUnit());
            const perp = v2.perp(away);
            const dir = v2.normalizeSafe(
                v2.add(
                    v2.mul(away, combat.evadeAwayFrac),
                    v2.mul(perp, (1 - combat.evadeAwayFrac) * combat.evadePerpSign),
                ),
                away,
            );

            const raw = v2.add(player.pos, v2.mul(dir, retreatDist));
            return sanitizeGoal(v2.lerp(0.22, raw, game.gas.posNew));
        };

        const pickCoverPoint = (source: { x: number; y: number }) => {
            if (gasEmergency) return undefined;

            const sourceId = actionableTarget?.__id;
            if (
                sourceId !== undefined &&
                timeNow < combat.coverUntil &&
                combat.coverTargetId === sourceId &&
                combat.coverPos
            ) {
                const cached = combat.coverPos;
                if (!gas.isInGas(cached) && !gas.isOutSideSafeZone(cached)) {
                    return cached;
                }
            }

            const isCoverPosValid = (pos: { x: number; y: number }) => {
                if (gas.isInGas(pos) || gas.isOutSideSafeZone(pos)) return false;
                if (game.map.isOnWater(pos, player.layer)) return false;
                return true;
            };

            const hasLineOfSight = (
                a: { x: number; y: number },
                b: { x: number; y: number },
                height: number,
                hackStairs: boolean,
            ): boolean => {
                const len = v2.distance(a, b);
                if (len <= 0.0001) return true;

                const dir = v2.normalizeSafe(v2.sub(b, a), v2.create(1, 0));
                const aabb = coldet.lineSegmentToAabb(a, b);
                const nearby = game.grid.intersectCollider(aabb);
                const obstacles = nearby.filter(
                    (o) => o.__type === ObjectType.Obstacle,
                ) as any[];

                const dist = collisionHelpers.intersectSegmentDist(
                    obstacles,
                    a,
                    dir,
                    len,
                    height,
                    player.layer,
                    hackStairs,
                );

                return dist >= len - 0.05;
            };

            const candidates: Array<{ pos: Vec2; score: number }> = [];
            const consider = (candidate: Vec2) => {
                game.map.clampToMapBounds(candidate);
                if (!isCoverPosValid(candidate)) return;
                if (hasLineOfSight(source, candidate, GameConfig.bullet.height, true)) return;

                const distFromBot = v2.distance(player.pos, candidate);
                const distFromEnemy = v2.distance(source, candidate);
                const reachable = hasLineOfSight(player.pos, candidate, 0, false);
                const score =
                    1000 -
                    distFromBot * brainProfile.coverBotDistWeight +
                    distFromEnemy * brainProfile.coverEnemyDistWeight -
                    (reachable ? 0 : brainProfile.coverReachPenalty);
                candidates.push({ pos: v2.copy(candidate), score });
            };

            const away = v2.normalizeSafe(v2.sub(player.pos, source), v2.create(1, 0));
            const arc = Math.PI / 2;
            const ringCount = util.randomInt(
                brainProfile.coverRingSamplesMin,
                brainProfile.coverRingSamplesMax,
            );
            const randomCount = util.randomInt(
                brainProfile.coverRandomSamplesMin,
                brainProfile.coverRandomSamplesMax,
            );

            for (let i = 0; i < ringCount; i++) {
                const t = ringCount === 1 ? 0.5 : i / Math.max(ringCount - 1, 1);
                const dir = v2.rotate(away, math.lerp(t, -arc, arc));
                consider(v2.add(player.pos, v2.mul(dir, util.random(10, 14))));
            }

            for (let i = 0; i < randomCount; i++) {
                consider(v2.add(player.pos, v2.mul(v2.randomUnit(), util.random(4, 14))));
            }

            candidates.sort((a, b) => b.score - a.score);
            if (sourceId !== undefined) {
                combat.coverTargetId = sourceId;
            }
            combat.coverUntil = timeNow + util.random(0.75, 1.5);

            if (candidates.length > 0) {
                const choiceIdx =
                    candidates.length > 1 &&
                    brainProfile.coverImperfectChoiceChance > 0 &&
                    Math.random() < brainProfile.coverImperfectChoiceChance
                        ? 1
                        : 0;
                combat.coverPos = candidates[choiceIdx].pos;
                return combat.coverPos;
            }

            combat.coverPos = undefined;
            return undefined;
        };

        combat.goalPos = undefined;
        combat.movementStyle = "direct";
        combat.lootTargetId = undefined;
        combat.lootWeaponSlot = undefined;
        combat.objectTargetId = undefined;
        combat.objectInteractionMode = undefined;

        switch (state) {
            case "loot": {
                const chosenLoot = immediateGun ?? fallbackLoot;
                if (chosenLoot) {
                    combat.goalPos = sanitizeGoal(chosenLoot.pos);
                    combat.lootTargetId = chosenLoot.lootId;
                    combat.lootWeaponSlot = chosenLoot.weaponSlot;
                } else {
                    combat.goalPos = navigation.waypoint
                        ? sanitizeGoal(navigation.waypoint)
                        : sanitizeGoal(game.gas.posNew);
                }
                break;
            }
            case "interact_object":
                if (objectGoal) {
                    combat.goalPos = sanitizeGoal(objectGoal.pos);
                    combat.objectTargetId = objectGoal.obstacleId;
                    combat.objectInteractionMode = objectGoal.mode;
                } else if (
                    prevState === "interact_object" &&
                    prevObjectTargetId !== undefined &&
                    prevObjectGoal &&
                    prevObjectInteractionMode !== undefined
                ) {
                    combat.goalPos = sanitizeGoal(prevObjectGoal);
                    combat.objectTargetId = prevObjectTargetId;
                    combat.objectInteractionMode = prevObjectInteractionMode;
                } else {
                    combat.goalPos = navigation.waypoint
                        ? sanitizeGoal(navigation.waypoint)
                        : sanitizeGoal(game.gas.posNew);
                }
                break;
            case "back_off": {
                const retreatFrom =
                    actionableTarget?.pos ??
                    combat.unarmedThreatPos ??
                    perception.lastSeenPos;
                combat.goalPos = retreatFrom
                    ? retreatPointFrom(retreatFrom, 14)
                    : navigation.waypoint
                      ? sanitizeGoal(navigation.waypoint)
                      : sanitizeGoal(game.gas.posNew);
                break;
            }
            case "seek_cover": {
                const retreatFrom =
                    actionableTarget?.pos ??
                    combat.unarmedThreatPos ??
                    perception.lastSeenPos;
                combat.goalPos = retreatFrom
                    ? pickCoverPoint(retreatFrom) ?? retreatPointFrom(retreatFrom, 16)
                    : navigation.waypoint
                      ? sanitizeGoal(navigation.waypoint)
                      : sanitizeGoal(game.gas.posNew);
                break;
            }
            case "wander":
            default:
                combat.goalPos = navigation.waypoint
                    ? sanitizeGoal(navigation.waypoint)
                    : sanitizeGoal(game.gas.posNew);
                break;
        }

        if (Config.bots.debugCombat && stateChanged) {
            logBotCombat({
                botId: player.__id,
                brainType,
                state,
                stateReason: reason,
                danger: Number(danger.toFixed(3)),
                hp: Math.round(player.health),
                dist: actionableTarget
                    ? Number(v2.distance(player.pos, actionableTarget.pos).toFixed(2))
                    : undefined,
                visible: visibleHostile,
                recentlyDamaged,
                gasEmergency,
                unarmed: true,
                hostileHasShownGun: threatContext.hostileHasShownGun,
                hostileDistracted: threatContext.hostileDistracted,
                targetId: actionableTarget?.__id,
                targetX: actionableTarget
                    ? Number(actionableTarget.pos.x.toFixed(2))
                    : undefined,
                targetY: actionableTarget
                    ? Number(actionableTarget.pos.y.toFixed(2))
                    : undefined,
                goalX: combat.goalPos ? Number(combat.goalPos.x.toFixed(2)) : undefined,
                goalY: combat.goalPos ? Number(combat.goalPos.y.toFixed(2)) : undefined,
                movementStyle: combat.movementStyle,
                lootTargetId: combat.lootTargetId,
                objectTargetId: combat.objectTargetId,
                objectInteractionMode: combat.objectInteractionMode,
            });
        }

        if (stateChanged) {
            logBotStability("state_change", {
                brainType,
                botId: player.__id,
                state,
                reason,
                previousState: prevState,
                hp: Math.round(player.health),
                danger: Number(danger.toFixed(3)),
                distToTarget: actionableTarget
                    ? Number(v2.distance(player.pos, actionableTarget.pos).toFixed(2))
                    : undefined,
                visible: visibleHostile,
                gasEmergency,
                unarmed: true,
                hostileHasShownGun: threatContext.hostileHasShownGun,
                hostileAppearsUnarmed: threatContext.hostileAppearsUnarmed,
                hostileDistracted: threatContext.hostileDistracted,
                targetId: actionableTarget?.__id,
                targetX: actionableTarget
                    ? Number(actionableTarget.pos.x.toFixed(2))
                    : undefined,
                targetY: actionableTarget
                    ? Number(actionableTarget.pos.y.toFixed(2))
                    : undefined,
                goalX: combat.goalPos ? Number(combat.goalPos.x.toFixed(2)) : undefined,
                goalY: combat.goalPos ? Number(combat.goalPos.y.toFixed(2)) : undefined,
                movementStyle: combat.movementStyle,
                lootTargetId: combat.lootTargetId,
                objectTargetId: combat.objectTargetId,
                objectInteractionMode: combat.objectInteractionMode,
            });
        }
    }
}
