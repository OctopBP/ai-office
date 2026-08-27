/**
 * Пикселизация сцены — та же связка, что в примере three.js
 * `webgl_postprocessing_pixel`: комната рисуется в низкое разрешение, а затем
 * растягивается на канвас без сглаживания, и поверх по буферам нормалей и
 * глубины дорисовываются контуры — светлый на изломе поверхности, тёмный на
 * границе предмета. Получается пиксель-арт, но настоящий трёхмерный: свет,
 * тени и облёт остаются, меняется только то, чем это показано.
 *
 * Проход берётся готовый (`RenderPixelatedPass` из addons three), своего
 * шейдера здесь нет — есть только сборка композитора и его жизнь внутри R3F.
 *
 * Пока компонент смонтирован, кадр рисует он: `useFrame` с приоритетом больше
 * нуля отключает собственный рендер R3F. Размонтировали — R3F тут же
 * возвращается к обычному рендеру, поэтому выключатель в настройках это
 * просто отсутствие компонента в дереве, без ручного восстановления
 * состояния рендерера.
 */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';

/** Приоритет кадра. Больше нуля — значит «рисую сам»; все обычные `useFrame`
 *  сцены (гашение стен, ходьба агентов) идут с нулём и успевают отработать
 *  раньше, потому что R3F зовёт подписчиков по возрастанию приоритета. */
const PRIORITY = 1;

export function Pixelation({ pixelSize, normalEdge, depthEdge }: {
  pixelSize: number;
  normalEdge: number;
  depthEdge: number;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  const { composer, pass } = useMemo(() => {
    const pass = new RenderPixelatedPass(pixelSize, scene, camera);
    const output = new OutputPass();
    const composer = new EffectComposer(gl);
    /**
     * Композитор считает в css-точках, а не в точках экрана: тогда «пиксель
     * размером 4» на любом мониторе выглядит одинаково крупно. Иначе на
     * retina тот же размер дал бы вдвое более мелкую клетку — настройка
     * означала бы разное на разных машинах. На резкость это не влияет:
     * растягивается результат всё равно на весь канвас в его настоящем
     * разрешении.
     */
    composer.setPixelRatio(1);
    composer.addPass(pass);
    /**
     * Последним — перевод в цветовое пространство экрана. Без него картинка
     * темнеет: сцена считается в линейном цвете, и обратно его переводит
     * рендерер, но только когда рисует прямо в канвас. Здесь он рисует в
     * буфер, и перевод остаётся за этим проходом. Тонмаппинг проход берёт у
     * рендерера, а там `flat` — то есть никакого, ровно как и было.
     */
    composer.addPass(output);
    return { composer, pass };
    // pixelSize здесь только стартовое значение — дальше его двигает эффект
    // ниже, пересобирать композитор ради него незачем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);

  useEffect(() => () => {
    for (const p of composer.passes) p.dispose();
    composer.dispose();
  }, [composer]);

  // Размер — раньше размера пикселя: `setPixelSize` пересчитывает разрешение
  // от него, и на первом кадре композитор должен уже знать размер канваса.
  useEffect(() => {
    if (width < 1 || height < 1) return;
    composer.setSize(width, height);
  }, [composer, width, height]);

  useEffect(() => {
    pass.setPixelSize(Math.max(1, Math.round(pixelSize)));
  }, [pass, pixelSize]);

  useEffect(() => {
    pass.normalEdgeStrength = normalEdge;
    pass.depthEdgeStrength = depthEdge;
  }, [pass, normalEdge, depthEdge]);

  useFrame((_, dt) => {
    composer.render(dt);
  }, PRIORITY);

  return null;
}
