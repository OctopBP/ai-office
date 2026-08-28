/**
 * Общее состояние сцены-портрета — только флаг «упала».
 *
 * Сама сцена и её холст живут в `AgentAvatar.tsx`, а этот флажок нужен,
 * чтобы одна ошибка WebGL (потерянный контекст, сломанная сборка шейдера)
 * выключала 3D сразу у всех аватарок, а не у одной: причина одна на всех —
 * общий рендерер, — и разбираться с ней порознь, ловя одно и то же
 * исключение по многу раз, незачем.
 */
import { create } from 'zustand';

interface AvatarStageState {
  broken: boolean;
  setBroken: () => void;
}

export const useAvatarStage = create<AvatarStageState>((set) => ({
  broken: false,
  setBroken: () => set({ broken: true }),
}));
