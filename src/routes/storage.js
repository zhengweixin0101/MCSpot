const express = require('express');
const { authenticate, checkPermission } = require('../middleware/auth');
const { getArchiveList, getDownloadLink, deleteArchive } = require('../services/storageService');

const router = express.Router();

// 获取存档列表
router.get('/archives', authenticate, checkPermission('admin'), async (req, res) => {
  try {
    const result = await getArchiveList();
    res.json(result);
  } catch (err) {
    console.error('获取存档列表失败:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 验证密码并获取下载链接
router.post('/archives/download', authenticate, checkPermission('admin'), async (req, res) => {
  try {
    const { key, password } = req.body;
    const userId = req.auth.userId;
    
    const result = await getDownloadLink(key, password, userId);
    res.json(result);

  } catch (err) {
    console.error('获取下载链接失败:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 删除存档
router.delete('/archives', authenticate, checkPermission('admin'), async (req, res) => {
  try {
    const { key } = req.body;
    
    const result = await deleteArchive(key);
    res.json(result);
    
  } catch (err) {
    console.error('删除存档失败:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;