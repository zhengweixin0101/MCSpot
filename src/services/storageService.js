const COS = require('cos-nodejs-sdk-v5');
const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { AUTH_PASSWORDS } = require('../middleware/auth');
const dotenv = require('dotenv');

dotenv.config();

// 获取存档列表
async function getArchiveList() {
  try {
    const storageType = process.env.STORAGE_TYPE || 'cos';
    let files = [];

    if (storageType === 'cos') {
      const cos = new COS({
        SecretId: process.env.TENCENT_SECRET_ID,
        SecretKey: process.env.TENCENT_SECRET_KEY,
      });
      const bucket = process.env.COS_BUCKET;
      const region = process.env.COS_REGION;
      // 默认路径为 mc/
      const prefix = process.env.COS_PREFIX || 'mc/';

      if (!bucket || !region) {
        return { success: true, files: [], message: 'COS配置未完成' };
      }

      const data = await new Promise((resolve, reject) => {
        cos.getBucket({
          Bucket: bucket,
          Region: region,
          Prefix: prefix,
        }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      
      files = (data.Contents || []).map(item => ({
        key: item.Key,
        name: item.Key.replace(new RegExp(`^${prefix}`), ''), // 去除前缀
        size: parseInt(item.Size),
        lastModified: item.LastModified
      }));
      
    } else if (storageType === 's3') {
      const s3 = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY
        },
        forcePathStyle: true
      });
      const bucket = process.env.S3_BUCKET;
      // 默认路径为 mc/
      let prefix = process.env.S3_PREFIX || 'mc/';
      
      // S3 Prefix 不应以 / 开头，如果配置了 / 开头则去除
      if (prefix.startsWith('/')) {
        prefix = prefix.substring(1);
      }
            
      if (!bucket) {
        return { success: true, files: [], message: 'S3配置未完成' };
      }

      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix
      });
      const data = await s3.send(command);
      
      files = await Promise.all((data.Contents || []).map(async (item) => {
        return {
          key: item.Key,
          name: item.Key.replace(new RegExp(`^${prefix}`), ''), // 去除前缀
          size: item.Size,
          lastModified: item.LastModified
        };
      }));
    }

    files.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    return { success: true, files };
  } catch (err) {
    console.error('获取存档列表失败:', err);
    throw new Error(`获取存档列表失败: ${err.message}`);
  }
}

// 验证密码并获取下载链接
async function getDownloadLink(key, password, userId) {
  try {
    if (!key || !password) {
      throw new Error('参数不完整');
    }

    const userConfig = AUTH_PASSWORDS[userId];

    if (!userConfig || userConfig.password !== password) {
      throw new Error('密码验证失败');
    }

    const storageType = process.env.STORAGE_TYPE || 'cos';
    let url = '';

    if (storageType === 'cos') {
      const cos = new COS({
        SecretId: process.env.TENCENT_SECRET_ID,
        SecretKey: process.env.TENCENT_SECRET_KEY,
      });
      const bucket = process.env.COS_BUCKET;
      const region = process.env.COS_REGION;

      url = cos.getObjectUrl({
        Bucket: bucket,
        Region: region,
        Key: key,
        Sign: true,
        Expires: 3600
      });
    } else if (storageType === 's3') {
      const s3 = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY
        },
        forcePathStyle: true
      });
      const bucket = process.env.S3_BUCKET;

      const getCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: key
      });
      url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
    }

    return { success: true, url };

  } catch (err) {
    console.error('获取下载链接失败:', err);
    throw new Error(`获取下载链接失败: ${err.message}`);
  }
}

// 删除存档
async function deleteArchive(key) {
  try {
    if (!key) {
      throw new Error('缺少文件key参数');
    }
    
    // 安全检查：不允许删除 world.zip
    if (key.endsWith('world.zip')) {
      throw new Error('禁止删除 world.zip 存档');
    }

    const storageType = process.env.STORAGE_TYPE || 'cos';
    
    if (storageType === 'cos') {
      const cos = new COS({
        SecretId: process.env.TENCENT_SECRET_ID,
        SecretKey: process.env.TENCENT_SECRET_KEY,
      });
      const bucket = process.env.COS_BUCKET;
      const region = process.env.COS_REGION;

      await new Promise((resolve, reject) => {
        cos.deleteObject({
          Bucket: bucket,
          Region: region,
          Key: key,
        }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      
    } else if (storageType === 's3') {
      const s3 = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY
        },
        forcePathStyle: true
      });
      const bucket = process.env.S3_BUCKET;

      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key
      });
      
      await s3.send(command);
    }
    
    return { success: true, message: '删除成功' };
    
  } catch (err) {
    console.error('删除存档失败:', err);
    throw new Error(`删除存档失败: ${err.message}`);
  }
}

module.exports = {
  getArchiveList,
  getDownloadLink,
  deleteArchive
};