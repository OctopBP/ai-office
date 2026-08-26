/**
 * Модели мебели, которые комната действительно использует.
 *
 * Набор Kenney «Furniture Kit» (CC0, `design/models/furniture/LICENSE.txt`) —
 * это 140 предметов, и лежит он в репозитории целиком: выбирать декорацию
 * удобнее из полного набора, чем доносить файлы по одному. Но подключены
 * отсюда только те, что стоят в комнате.
 *
 * Список именно поимённый, а не глоб по папке. Глоб с `eager` превращается в
 * 140 статических импортов, и в разработке браузер тянет весь набор при
 * открытии комнаты — два мегабайта и сотня запросов ради четырёх моделей.
 * Одна строка на предмет — небольшая цена за то, чтобы этого не происходило.
 */
import chairDesk from '../../../design/models/furniture/chairDesk.glb?url';
import computerScreen from '../../../design/models/furniture/computerScreen.glb?url';
import desk from '../../../design/models/furniture/desk.glb?url';
import loungeSofa from '../../../design/models/furniture/loungeSofa.glb?url';

export const MODEL_URLS: Record<string, string> = {
  chairDesk,
  computerScreen,
  desk,
  loungeSofa,
};
