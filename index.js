const app = require('./src/app');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config();

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`MCSpot - Minecraft 服务器按需启动工具`);
  console.log(``);
  console.log(`服务运行在 http://localhost:${PORT}`);
  console.log(`========================================`);
});