import { GameObjectDefs } from "../../../../../shared/defs/gameObjectDefs";
import type { BulletDef } from "../../../../../shared/defs/gameObjects/bulletDefs";
import type { GunDef } from "../../../../../shared/defs/gameObjects/gunDefs";
import { math } from "../../../../../shared/utils/math";
import { type Vec2, v2 } from "../../../../../shared/utils/v2";
import type { Player } from "../../objects/player";
import type { BotDifficulty } from "../botDifficulty";
import { SkillProfiles } from "./botSkillProfiles";

function wrapAngleRad(rad: number): number {
    return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function approachAngleRad(curRad: number, targetRad: number, maxDeltaRad: number): number {
    const delta = wrapAngleRad(targetRad - curRad);
    if (Math.abs(delta) <= maxDeltaRad) return targetRad;
    return curRad + Math.sign(delta) * maxDeltaRad;
}

function absAngleDiffDeg(aRad: number, bRad: number): number {
    return Math.abs(math.rad2deg(wrapAngleRad(bRad - aRad)));
}

export class BotAimController {
    aimAngleRad = 0;
    targetAngleRad = 0;
    focusTime = 0;

    constructor(player: Player, readonly difficulty: BotDifficulty) {
        this.aimAngleRad = Math.atan2(player.dir.y, player.dir.x);
    }

    resetFocus(): void {
        this.focusTime = 0;
    }

    /**
     * Updates aim toward a goal/target with smoothing and optional lead prediction.
     */
    update(dt: number, params: {
        player: Player;
        goal?: Vec2;
        target?: Player;
        gunDef?: GunDef;
    }): {
        aimDir: Vec2;
        angleDeltaDeg: number;
        aimLen: number;
        distToTarget: number;
    } {
        const { player, goal, target, gunDef } = params;
        const skill = SkillProfiles[this.difficulty];

        let aimLen = 0;
        let distToTarget = Infinity;

        if (target) {
            distToTarget = v2.distance(player.pos, target.pos);
            aimLen = distToTarget;

            let predictedPos = target.pos;
            if (gunDef) {
                const bulletDef = GameObjectDefs[gunDef.bulletType] as BulletDef | undefined;
                const bulletSpeed = bulletDef?.speed ?? 1;
                const tLead = math.clamp(
                    (distToTarget / Math.max(bulletSpeed, 1)) * skill.predictionLeadScale,
                    0,
                    0.35,
                );
                predictedPos = v2.add(target.pos, v2.mul(target.moveVel, tLead));
            }

            this.targetAngleRad = Math.atan2(
                predictedPos.y - player.pos.y,
                predictedPos.x - player.pos.x,
            );
        } else if (goal) {
            aimLen = v2.distance(player.pos, goal);
            this.targetAngleRad = Math.atan2(goal.y - player.pos.y, goal.x - player.pos.x);
        }

        const maxDeltaRad = math.deg2rad(skill.trackingDegPerSec) * dt;
        this.aimAngleRad = approachAngleRad(this.aimAngleRad, this.targetAngleRad, maxDeltaRad);

        const aimDir = v2.create(Math.cos(this.aimAngleRad), Math.sin(this.aimAngleRad));
        const angleDeltaDeg = absAngleDiffDeg(this.aimAngleRad, this.targetAngleRad);

        return { aimDir, angleDeltaDeg, aimLen, distToTarget };
    }

    getDirWithNoiseDeg(noiseDeg: number): Vec2 {
        const shotAngleRad = this.aimAngleRad + math.deg2rad(noiseDeg);
        return v2.create(Math.cos(shotAngleRad), Math.sin(shotAngleRad));
    }
}

