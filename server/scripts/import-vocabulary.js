/**
 * 批量导入看图识字内容
 * 运行方式: node scripts/import-vocabulary.js
 */

const axios = require('axios');

const ADMIN_API = 'http://localhost:3002/api/admin';

// 单词数据 - 按分类组织
const vocabularyData = {
    // 动物 (category_id: 1)
    animals: [
        { word: 'cat', phonetic: '/kæt/', translation: '猫', example_sentence: 'I have a cute cat.', example_translation: '我有一只可爱的猫。' },
        { word: 'dog', phonetic: '/dɒɡ/', translation: '狗', example_sentence: 'The dog is running.', example_translation: '狗在跑。' },
        { word: 'bird', phonetic: '/bɜːd/', translation: '鸟', example_sentence: 'The bird can fly.', example_translation: '鸟会飞。' },
        { word: 'fish', phonetic: '/fɪʃ/', translation: '鱼', example_sentence: 'The fish swims in water.', example_translation: '鱼在水里游。' },
        { word: 'rabbit', phonetic: '/ˈræbɪt/', translation: '兔子', example_sentence: 'The rabbit has long ears.', example_translation: '兔子有长耳朵。' },
        { word: 'elephant', phonetic: '/ˈelɪfənt/', translation: '大象', example_sentence: 'The elephant is very big.', example_translation: '大象非常大。' },
        { word: 'lion', phonetic: '/ˈlaɪən/', translation: '狮子', example_sentence: 'The lion is the king.', example_translation: '狮子是王者。' },
        { word: 'tiger', phonetic: '/ˈtaɪɡə/', translation: '老虎', example_sentence: 'The tiger has stripes.', example_translation: '老虎有条纹。' },
        { word: 'monkey', phonetic: '/ˈmʌŋki/', translation: '猴子', example_sentence: 'The monkey likes bananas.', example_translation: '猴子喜欢香蕉。' },
        { word: 'panda', phonetic: '/ˈpændə/', translation: '熊猫', example_sentence: 'The panda eats bamboo.', example_translation: '熊猫吃竹子。' },
        { word: 'bear', phonetic: '/beə/', translation: '熊', example_sentence: 'The bear is sleeping.', example_translation: '熊在睡觉。' },
        { word: 'duck', phonetic: '/dʌk/', translation: '鸭子', example_sentence: 'The duck says quack.', example_translation: '鸭子嘎嘎叫。' },
        { word: 'chicken', phonetic: '/ˈtʃɪkɪn/', translation: '鸡', example_sentence: 'The chicken lays eggs.', example_translation: '鸡下蛋。' },
        { word: 'pig', phonetic: '/pɪɡ/', translation: '猪', example_sentence: 'The pig is pink.', example_translation: '猪是粉红色的。' },
        { word: 'cow', phonetic: '/kaʊ/', translation: '奶牛', example_sentence: 'The cow gives milk.', example_translation: '奶牛产奶。' },
        { word: 'sheep', phonetic: '/ʃiːp/', translation: '绵羊', example_sentence: 'The sheep has wool.', example_translation: '绵羊有羊毛。' },
        { word: 'horse', phonetic: '/hɔːs/', translation: '马', example_sentence: 'The horse runs fast.', example_translation: '马跑得快。' },
        { word: 'frog', phonetic: '/frɒɡ/', translation: '青蛙', example_sentence: 'The frog can jump.', example_translation: '青蛙会跳。' },
        { word: 'snake', phonetic: '/sneɪk/', translation: '蛇', example_sentence: 'The snake has no legs.', example_translation: '蛇没有腿。' },
        { word: 'butterfly', phonetic: '/ˈbʌtəflaɪ/', translation: '蝴蝶', example_sentence: 'The butterfly is beautiful.', example_translation: '蝴蝶很漂亮。' }
    ],

    // 水果蔬菜 (category_id: 2)
    fruits: [
        { word: 'apple', phonetic: '/ˈæpl/', translation: '苹果', example_sentence: 'I eat an apple every day.', example_translation: '我每天吃一个苹果。' },
        { word: 'banana', phonetic: '/bəˈnɑːnə/', translation: '香蕉', example_sentence: 'The banana is yellow.', example_translation: '香蕉是黄色的。' },
        { word: 'orange', phonetic: '/ˈɒrɪndʒ/', translation: '橙子', example_sentence: 'I like orange juice.', example_translation: '我喜欢橙汁。' },
        { word: 'grape', phonetic: '/ɡreɪp/', translation: '葡萄', example_sentence: 'Grapes are sweet.', example_translation: '葡萄很甜。' },
        { word: 'watermelon', phonetic: '/ˈwɔːtəmelən/', translation: '西瓜', example_sentence: 'Watermelon is refreshing.', example_translation: '西瓜很解渴。' },
        { word: 'strawberry', phonetic: '/ˈstrɔːbəri/', translation: '草莓', example_sentence: 'Strawberries are red.', example_translation: '草莓是红色的。' },
        { word: 'peach', phonetic: '/piːtʃ/', translation: '桃子', example_sentence: 'The peach is juicy.', example_translation: '桃子多汁。' },
        { word: 'pear', phonetic: '/peə/', translation: '梨', example_sentence: 'The pear is green.', example_translation: '梨是绿色的。' },
        { word: 'tomato', phonetic: '/təˈmɑːtəʊ/', translation: '番茄', example_sentence: 'Tomatoes are red.', example_translation: '番茄是红色的。' },
        { word: 'carrot', phonetic: '/ˈkærət/', translation: '胡萝卜', example_sentence: 'Rabbits like carrots.', example_translation: '兔子喜欢胡萝卜。' },
        { word: 'potato', phonetic: '/pəˈteɪtəʊ/', translation: '土豆', example_sentence: 'I like French fries.', example_translation: '我喜欢薯条。' },
        { word: 'cucumber', phonetic: '/ˈkjuːkʌmbə/', translation: '黄瓜', example_sentence: 'Cucumber is crunchy.', example_translation: '黄瓜很脆。' },
        { word: 'corn', phonetic: '/kɔːn/', translation: '玉米', example_sentence: 'Corn is yellow.', example_translation: '玉米是黄色的。' },
        { word: 'cabbage', phonetic: '/ˈkæbɪdʒ/', translation: '卷心菜', example_sentence: 'Cabbage is green.', example_translation: '卷心菜是绿色的。' },
        { word: 'onion', phonetic: '/ˈʌnjən/', translation: '洋葱', example_sentence: 'Onions make me cry.', example_translation: '洋葱让我流泪。' }
    ],

    // 颜色形状 (category_id: 3)
    colors: [
        { word: 'red', phonetic: '/red/', translation: '红色', word_type: 'adj', example_sentence: 'The apple is red.', example_translation: '苹果是红色的。' },
        { word: 'blue', phonetic: '/bluː/', translation: '蓝色', word_type: 'adj', example_sentence: 'The sky is blue.', example_translation: '天空是蓝色的。' },
        { word: 'yellow', phonetic: '/ˈjeləʊ/', translation: '黄色', word_type: 'adj', example_sentence: 'The sun is yellow.', example_translation: '太阳是黄色的。' },
        { word: 'green', phonetic: '/ɡriːn/', translation: '绿色', word_type: 'adj', example_sentence: 'The grass is green.', example_translation: '草是绿色的。' },
        { word: 'orange', phonetic: '/ˈɒrɪndʒ/', translation: '橙色', word_type: 'adj', example_sentence: 'The carrot is orange.', example_translation: '胡萝卜是橙色的。' },
        { word: 'purple', phonetic: '/ˈpɜːpl/', translation: '紫色', word_type: 'adj', example_sentence: 'Grapes are purple.', example_translation: '葡萄是紫色的。' },
        { word: 'pink', phonetic: '/pɪŋk/', translation: '粉色', word_type: 'adj', example_sentence: 'The flower is pink.', example_translation: '花是粉色的。' },
        { word: 'black', phonetic: '/blæk/', translation: '黑色', word_type: 'adj', example_sentence: 'The night is black.', example_translation: '夜晚是黑色的。' },
        { word: 'white', phonetic: '/waɪt/', translation: '白色', word_type: 'adj', example_sentence: 'Snow is white.', example_translation: '雪是白色的。' },
        { word: 'brown', phonetic: '/braʊn/', translation: '棕色', word_type: 'adj', example_sentence: 'The bear is brown.', example_translation: '熊是棕色的。' },
        { word: 'circle', phonetic: '/ˈsɜːkl/', translation: '圆形', example_sentence: 'The ball is a circle.', example_translation: '球是圆形的。' },
        { word: 'square', phonetic: '/skweə/', translation: '正方形', example_sentence: 'The box is a square.', example_translation: '盒子是正方形的。' },
        { word: 'triangle', phonetic: '/ˈtraɪæŋɡl/', translation: '三角形', example_sentence: 'The roof is a triangle.', example_translation: '屋顶是三角形的。' },
        { word: 'star', phonetic: '/stɑː/', translation: '星形', example_sentence: 'Stars twinkle at night.', example_translation: '星星在夜晚闪烁。' },
        { word: 'heart', phonetic: '/hɑːt/', translation: '心形', example_sentence: 'I love heart shapes.', example_translation: '我喜欢心形。' }
    ],

    // 数字日期 (category_id: 4)
    numbers: [
        { word: 'one', phonetic: '/wʌn/', translation: '一', display_mode: 'icon', example_sentence: 'I have one book.', example_translation: '我有一本书。' },
        { word: 'two', phonetic: '/tuː/', translation: '二', display_mode: 'icon', example_sentence: 'I have two hands.', example_translation: '我有两只手。' },
        { word: 'three', phonetic: '/θriː/', translation: '三', display_mode: 'icon', example_sentence: 'There are three apples.', example_translation: '有三个苹果。' },
        { word: 'four', phonetic: '/fɔː/', translation: '四', display_mode: 'icon', example_sentence: 'A cat has four legs.', example_translation: '猫有四条腿。' },
        { word: 'five', phonetic: '/faɪv/', translation: '五', display_mode: 'icon', example_sentence: 'I have five fingers.', example_translation: '我有五根手指。' },
        { word: 'six', phonetic: '/sɪks/', translation: '六', display_mode: 'icon', example_sentence: 'There are six eggs.', example_translation: '有六个鸡蛋。' },
        { word: 'seven', phonetic: '/ˈsevn/', translation: '七', display_mode: 'icon', example_sentence: 'A week has seven days.', example_translation: '一周有七天。' },
        { word: 'eight', phonetic: '/eɪt/', translation: '八', display_mode: 'icon', example_sentence: 'An octopus has eight arms.', example_translation: '章鱼有八条手臂。' },
        { word: 'nine', phonetic: '/naɪn/', translation: '九', display_mode: 'icon', example_sentence: 'There are nine planets.', example_translation: '有九大行星。' },
        { word: 'ten', phonetic: '/ten/', translation: '十', display_mode: 'icon', example_sentence: 'I have ten toes.', example_translation: '我有十个脚趾。' },
        { word: 'Monday', phonetic: '/ˈmʌndeɪ/', translation: '星期一', display_mode: 'calendar', example_sentence: 'Monday is the first day.', example_translation: '星期一是第一天。' },
        { word: 'Tuesday', phonetic: '/ˈtjuːzdeɪ/', translation: '星期二', display_mode: 'calendar', example_sentence: 'I play sports on Tuesday.', example_translation: '我星期二运动。' },
        { word: 'Wednesday', phonetic: '/ˈwenzdeɪ/', translation: '星期三', display_mode: 'calendar', example_sentence: 'Wednesday is in the middle.', example_translation: '星期三在中间。' },
        { word: 'Thursday', phonetic: '/ˈθɜːzdeɪ/', translation: '星期四', display_mode: 'calendar', example_sentence: 'I have art on Thursday.', example_translation: '我星期四有美术课。' },
        { word: 'Friday', phonetic: '/ˈfraɪdeɪ/', translation: '星期五', display_mode: 'calendar', example_sentence: 'Friday is fun day.', example_translation: '星期五是快乐日。' },
        { word: 'Saturday', phonetic: '/ˈsætədeɪ/', translation: '星期六', display_mode: 'calendar', example_sentence: 'Saturday is weekend.', example_translation: '星期六是周末。' },
        { word: 'Sunday', phonetic: '/ˈsʌndeɪ/', translation: '星期日', display_mode: 'calendar', example_sentence: 'Sunday is rest day.', example_translation: '星期日是休息日。' }
    ],

    // 身体部位 (category_id: 5)
    body: [
        { word: 'head', phonetic: '/hed/', translation: '头', example_sentence: 'Touch your head.', example_translation: '摸摸你的头。' },
        { word: 'eye', phonetic: '/aɪ/', translation: '眼睛', example_sentence: 'I have two eyes.', example_translation: '我有两只眼睛。' },
        { word: 'ear', phonetic: '/ɪə/', translation: '耳朵', example_sentence: 'I hear with my ears.', example_translation: '我用耳朵听。' },
        { word: 'nose', phonetic: '/nəʊz/', translation: '鼻子', example_sentence: 'I smell with my nose.', example_translation: '我用鼻子闻。' },
        { word: 'mouth', phonetic: '/maʊθ/', translation: '嘴巴', example_sentence: 'I eat with my mouth.', example_translation: '我用嘴巴吃东西。' },
        { word: 'hand', phonetic: '/hænd/', translation: '手', example_sentence: 'Clap your hands.', example_translation: '拍拍手。' },
        { word: 'foot', phonetic: '/fʊt/', translation: '脚', example_sentence: 'Stamp your foot.', example_translation: '跺跺脚。' },
        { word: 'arm', phonetic: '/ɑːm/', translation: '手臂', example_sentence: 'Raise your arms.', example_translation: '举起手臂。' },
        { word: 'leg', phonetic: '/leɡ/', translation: '腿', example_sentence: 'I have two legs.', example_translation: '我有两条腿。' },
        { word: 'finger', phonetic: '/ˈfɪŋɡə/', translation: '手指', example_sentence: 'Point with your finger.', example_translation: '用手指指。' }
    ],

    // 家庭成员 (category_id: 6)
    family: [
        { word: 'father', phonetic: '/ˈfɑːðə/', translation: '爸爸', example_sentence: 'I love my father.', example_translation: '我爱我的爸爸。' },
        { word: 'mother', phonetic: '/ˈmʌðə/', translation: '妈妈', example_sentence: 'Mother cooks dinner.', example_translation: '妈妈做晚饭。' },
        { word: 'brother', phonetic: '/ˈbrʌðə/', translation: '兄弟', example_sentence: 'My brother is tall.', example_translation: '我的兄弟很高。' },
        { word: 'sister', phonetic: '/ˈsɪstə/', translation: '姐妹', example_sentence: 'My sister is kind.', example_translation: '我的姐妹很善良。' },
        { word: 'grandfather', phonetic: '/ˈɡrænfɑːðə/', translation: '爷爷/外公', example_sentence: 'Grandfather tells stories.', example_translation: '爷爷讲故事。' },
        { word: 'grandmother', phonetic: '/ˈɡrænmʌðə/', translation: '奶奶/外婆', example_sentence: 'Grandmother bakes cakes.', example_translation: '奶奶烤蛋糕。' },
        { word: 'baby', phonetic: '/ˈbeɪbi/', translation: '婴儿', example_sentence: 'The baby is sleeping.', example_translation: '婴儿在睡觉。' },
        { word: 'family', phonetic: '/ˈfæməli/', translation: '家庭', example_sentence: 'I love my family.', example_translation: '我爱我的家庭。' }
    ],

    // 日常用品 (category_id: 7)
    items: [
        { word: 'book', phonetic: '/bʊk/', translation: '书', example_sentence: 'I read a book.', example_translation: '我读书。' },
        { word: 'pen', phonetic: '/pen/', translation: '钢笔', example_sentence: 'Write with a pen.', example_translation: '用钢笔写字。' },
        { word: 'pencil', phonetic: '/ˈpensl/', translation: '铅笔', example_sentence: 'Draw with a pencil.', example_translation: '用铅笔画画。' },
        { word: 'bag', phonetic: '/bæɡ/', translation: '书包', example_sentence: 'Put books in the bag.', example_translation: '把书放进书包。' },
        { word: 'table', phonetic: '/ˈteɪbl/', translation: '桌子', example_sentence: 'The book is on the table.', example_translation: '书在桌子上。' },
        { word: 'chair', phonetic: '/tʃeə/', translation: '椅子', example_sentence: 'Sit on the chair.', example_translation: '坐在椅子上。' },
        { word: 'door', phonetic: '/dɔː/', translation: '门', example_sentence: 'Open the door.', example_translation: '开门。' },
        { word: 'window', phonetic: '/ˈwɪndəʊ/', translation: '窗户', example_sentence: 'Close the window.', example_translation: '关窗户。' },
        { word: 'clock', phonetic: '/klɒk/', translation: '时钟', example_sentence: 'Look at the clock.', example_translation: '看时钟。' },
        { word: 'phone', phonetic: '/fəʊn/', translation: '手机', example_sentence: 'Call me on the phone.', example_translation: '给我打电话。' }
    ],

    // 交通工具 (category_id: 8)
    transport: [
        { word: 'car', phonetic: '/kɑː/', translation: '汽车', example_sentence: 'Father drives a car.', example_translation: '爸爸开汽车。' },
        { word: 'bus', phonetic: '/bʌs/', translation: '公共汽车', example_sentence: 'Take the bus to school.', example_translation: '坐公交车去学校。' },
        { word: 'train', phonetic: '/treɪn/', translation: '火车', example_sentence: 'The train is fast.', example_translation: '火车很快。' },
        { word: 'plane', phonetic: '/pleɪn/', translation: '飞机', example_sentence: 'The plane can fly.', example_translation: '飞机会飞。' },
        { word: 'bike', phonetic: '/baɪk/', translation: '自行车', example_sentence: 'I ride a bike.', example_translation: '我骑自行车。' },
        { word: 'boat', phonetic: '/bəʊt/', translation: '船', example_sentence: 'The boat is on water.', example_translation: '船在水上。' },
        { word: 'ship', phonetic: '/ʃɪp/', translation: '轮船', example_sentence: 'The ship is big.', example_translation: '轮船很大。' },
        { word: 'taxi', phonetic: '/ˈtæksi/', translation: '出租车', example_sentence: 'Take a taxi home.', example_translation: '打出租车回家。' }
    ],

    // 食物饮料 (category_id: 9)
    food: [
        { word: 'bread', phonetic: '/bred/', translation: '面包', example_sentence: 'I eat bread for breakfast.', example_translation: '我早餐吃面包。' },
        { word: 'egg', phonetic: '/eɡ/', translation: '鸡蛋', example_sentence: 'I like eggs.', example_translation: '我喜欢鸡蛋。' },
        { word: 'milk', phonetic: '/mɪlk/', translation: '牛奶', example_sentence: 'Drink some milk.', example_translation: '喝点牛奶。' },
        { word: 'water', phonetic: '/ˈwɔːtə/', translation: '水', example_sentence: 'I drink water.', example_translation: '我喝水。' },
        { word: 'juice', phonetic: '/dʒuːs/', translation: '果汁', example_sentence: 'Orange juice is sweet.', example_translation: '橙汁很甜。' },
        { word: 'rice', phonetic: '/raɪs/', translation: '米饭', example_sentence: 'I eat rice for lunch.', example_translation: '我午餐吃米饭。' },
        { word: 'noodle', phonetic: '/ˈnuːdl/', translation: '面条', example_sentence: 'I like noodles.', example_translation: '我喜欢面条。' },
        { word: 'cake', phonetic: '/keɪk/', translation: '蛋糕', example_sentence: 'The cake is delicious.', example_translation: '蛋糕很好吃。' },
        { word: 'ice cream', phonetic: '/aɪs kriːm/', translation: '冰淇淋', example_sentence: 'I love ice cream.', example_translation: '我喜欢冰淇淋。' },
        { word: 'candy', phonetic: '/ˈkændi/', translation: '糖果', example_sentence: 'Candy is sweet.', example_translation: '糖果很甜。' }
    ],

    // 反义词 (category_id: 10)
    antonyms: [
        { word: 'big', phonetic: '/bɪɡ/', translation: '大的', word_type: 'adj', example_sentence: 'The elephant is big.', example_translation: '大象很大。' },
        { word: 'small', phonetic: '/smɔːl/', translation: '小的', word_type: 'adj', example_sentence: 'The ant is small.', example_translation: '蚂蚁很小。' },
        { word: 'hot', phonetic: '/hɒt/', translation: '热的', word_type: 'adj', example_sentence: 'Summer is hot.', example_translation: '夏天很热。' },
        { word: 'cold', phonetic: '/kəʊld/', translation: '冷的', word_type: 'adj', example_sentence: 'Winter is cold.', example_translation: '冬天很冷。' },
        { word: 'fast', phonetic: '/fɑːst/', translation: '快的', word_type: 'adj', example_sentence: 'The car is fast.', example_translation: '汽车很快。' },
        { word: 'slow', phonetic: '/sləʊ/', translation: '慢的', word_type: 'adj', example_sentence: 'The turtle is slow.', example_translation: '乌龟很慢。' },
        { word: 'tall', phonetic: '/tɔːl/', translation: '高的', word_type: 'adj', example_sentence: 'The giraffe is tall.', example_translation: '长颈鹿很高。' },
        { word: 'short', phonetic: '/ʃɔːt/', translation: '矮的', word_type: 'adj', example_sentence: 'The mouse is short.', example_translation: '老鼠很矮。' },
        { word: 'long', phonetic: '/lɒŋ/', translation: '长的', word_type: 'adj', example_sentence: 'The snake is long.', example_translation: '蛇很长。' },
        { word: 'happy', phonetic: '/ˈhæpi/', translation: '开心的', word_type: 'adj', example_sentence: 'I am happy.', example_translation: '我很开心。' },
        { word: 'sad', phonetic: '/sæd/', translation: '伤心的', word_type: 'adj', example_sentence: 'She is sad.', example_translation: '她很伤心。' },
        { word: 'new', phonetic: '/njuː/', translation: '新的', word_type: 'adj', example_sentence: 'I have a new toy.', example_translation: '我有一个新玩具。' },
        { word: 'old', phonetic: '/əʊld/', translation: '旧的', word_type: 'adj', example_sentence: 'The book is old.', example_translation: '这本书很旧。' },
        { word: 'good', phonetic: '/ɡʊd/', translation: '好的', word_type: 'adj', example_sentence: 'This is good.', example_translation: '这很好。' },
        { word: 'bad', phonetic: '/bæd/', translation: '坏的', word_type: 'adj', example_sentence: 'That is bad.', example_translation: '那很糟糕。' }
    ]
};

// 分类ID映射
const categoryMap = {
    animals: 1,
    fruits: 2,
    colors: 3,
    numbers: 4,
    body: 5,
    family: 6,
    items: 7,
    transport: 8,
    food: 9,
    antonyms: 10
};

async function importVocabulary() {
    console.log('🚀 开始批量导入单词...\n');

    let totalSuccess = 0;
    let totalFailed = 0;

    for (const [category, words] of Object.entries(vocabularyData)) {
        const categoryId = categoryMap[category];
        console.log(`📚 导入分类: ${category} (ID: ${categoryId})`);

        const wordsWithCategory = words.map(w => ({
            ...w,
            category_id: categoryId,
            difficulty_level: 1,
            word_type: w.word_type || 'noun',
            display_mode: w.display_mode || 'image'
        }));

        try {
            const response = await axios.post(`${ADMIN_API}/batch/words`, {
                words: wordsWithCategory,
                auto_generate_image: false,  // 暂不自动生成图片，可以后续批量生成
                auto_generate_audio: false   // 暂不自动生成音频
            });

            if (response.data.success) {
                console.log(`   ✅ 成功: ${response.data.data.success.length}, 失败: ${response.data.data.failed.length}`);
                totalSuccess += response.data.data.success.length;
                totalFailed += response.data.data.failed.length;
            } else {
                console.log(`   ❌ 导入失败: ${response.data.message}`);
            }
        } catch (error) {
            console.log(`   ❌ 请求错误: ${error.message}`);
        }
    }

    console.log('\n========================================');
    console.log(`📊 导入完成！成功: ${totalSuccess}, 失败: ${totalFailed}`);
    console.log('========================================');
}

importVocabulary();
