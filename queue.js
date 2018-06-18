/**
 * Created by blurooo on 2018/6/11.
 *
 * QQ: 946800151
 * github: github.com/blurooo
 *
 * 请在座的各位留点面子，如果有使用，给本人个露脸的机会不要删除这块，不胜感激。
 *
 */
function QueueTask(options) {

  let self = this;

  // 任务队列, 必然是一个函数, 执行返回一个Promise对象
  this.queueTasks = [];

  // 执行中任务个数
  this.runningTasksCount = 0;

  // 任务标签, 用于判断一组任务是否执行结束以及留存每个任务的响应
  // 通常状态是
  // {
  //    '任务组id': {
  //      results: [xx, ...],
  //      remainingCount: 10
  //    }
  // }
  // results一一对应了提交的每个任务最终的响应结果, remainingCount指示了该组任务剩余未执行任务数
  this.taskTag = {};

  // 超时识别的标志
  const timeoutFlag = 'queue_timeout';

  // 重试标识
  const retryFlag = 'queue_retry';

  // 默认的队列并发数
  const defaultConcurrency = 5;
  // 默认超时时间
  const defaultTimeout = 15000;
  // 默认重试次数
  const defaultRetry = 0;

  // 用于修正不正确的值
  function reviseValue(value, type, condition, defaultValue) {
    if (typeof value === type && condition) {
      return value;
    }
    return defaultValue;
  }

  // 设置参数
  function setOptions(newOptions) {
    // 修正不正确的参数设置
    if (newOptions) {
      newOptions.concurrency = reviseValue(newOptions.concurrency, 'number', newOptions.concurrency > 0, defaultConcurrency);
      newOptions.timeout = reviseValue(newOptions.timeout, 'number', newOptions.timeout >= 0, defaultTimeout);
      newOptions.retry = reviseValue(newOptions.retry, 'number', newOptions.retry >= 0, defaultRetry);
      newOptions.retryPrior = reviseValue(newOptions.retryPrior, 'boolean', newOptions.retryPrior === true, false);
      newOptions.newPrior = reviseValue(newOptions.newPrior, 'boolean', newOptions.newPrior === true, false);
      newOptions.catch = reviseValue(newOptions.catch, 'function', true, null);

      // 可配置选项
      self.options = Object.assign({
        // 任务并发数, 至少为1
        concurrency: defaultConcurrency,
        // 任务的超时时间
        timeout: defaultTimeout,
        // 任务出错重试的次数, 0为不重试
        retry: defaultRetry,
        // 是否优先处理重试任务, 决定了是将其重新置入队列前还是队列后
        retryPrior: false,
        // 是否新任务优先处理
        newPrior: false,
        // 任务出错的回调函数
        catch: null
      }, newOptions);
    }
  }

  // 初始化设置参数
  setOptions(options);

  // 自增计数器
  let autoIncrement = 0;

  // 实际添加任务到队列
  function putTask(task) {
    if (self.options.newPrior) {
      self.queueTasks.unshift(task);
    } else {
      self.queueTasks.push(task);
    }
  }

  // 添加任务, 可以添加单个, 也可以批量添加(数组形式)
  // 要求任务为一个function, 执行返回一个Promise对象(直接传promise对象会直接被执行, 达不到任务队列执行的效果)
  function put(tasks) {
    return new Promise((resolve) => {
      // 非有效任务, 直接返回
      if (!tasks || (!Array.isArray(tasks) && !(tasks instanceof Function))) {
        resolve();
      }
      // 空任务组
      if (Array.isArray(tasks) && tasks.length == 0) {
        resolve([]);
      }
      // 本次提交单个任务, 不贴标签, 执行完会直接调用then
      if (tasks instanceof Function) {
        // resolve  任务执行完毕直接调用resolve
        // func     记录任务的执行函数
        // retry    每个任务记录重试的次数
        // putTime  每个任务记录提交时间
        putTask({
          resolve,
          func: tasks,
          retry: 0,
          putTime: +new Date
        });
      } else {
        // 本次提交了一组任务, 生成一个唯一标签标识这一组任务, 用于关联该组任务是否全部执行完成
        let tag = genId();
        // 过滤掉不符合要求的任务类型
        let validTasks = tasks.filter(task => task instanceof Function);
        // 标注本次任务个数, 每个任务在执行完成时负责将对应标签剩余任务数减1, 最后一个任务则负责调用then
        self.taskTag[tag] = {
          // 该组任务对应每个任务的返回值储存在此处
          results: new Array(validTasks.length),
          remainingCount: validTasks.length
        };
        // 提交任务
        validTasks.forEach((task, index) => {
          // tag      标注一组任务
          // index    每个任务留存index, 以有序返回执行结果
          putTask({
            resolve,
            func: task,
            tag,
            index,
            retry: 0,
            putTime: +new Date
          });
        });
      }
      // 最大并发量 - 正在执行中的任务数 = 可以新增执行的任务数
      let newTaskCount = self.options.concurrency - self.runningTasksCount;
      if (newTaskCount < 1) {
        return;
      }
      // 每次put都是一个触发执行逻辑的时机
      runTask(newTaskCount);
    });
  }

  // 获取最早添加的若干个任务, 默认获取1个
  function get(count = 1) {
    count < 1 && (count = 1);
    return self.queueTasks.splice(0, count);
  }

  // 执行若干个任务
  function runTask(count) {
    // 取出最早的若干条任务
    let newTasks = get(count);
    // 执行新添加到队列的任务
    newTasks.forEach(task => {
      // 每个任务提交执行时, 将执行中任务数增1
      self.runningTasksCount++;
      // 如果指定了超时, 采用promise竞争来实现, 否则直接执行
      let p = (self.options.timeout > 0 ? Promise.race([delayPromise(self.options.timeout), task.func()]) : task.func());
      // 处理任务的后续
      taskHandler(task, p);
    });
  }

  function taskHandler(task, p) {
    let startTime = +new Date;
    p.then(res => {
      // 执行成功任务数减1
      self.runningTasksCount--;
      return {
        err: null,
        res,
        putUntilRunTime: startTime - task.putTime,
        runTime: +new Date - startTime,
        retry: task.retry
      };
    }).catch(err => {
      if (self.options.catch) {
        // 将运行错误的handler函数放置到执行序尾部，希望仅用于一些记录，不要影响队列的正常运作
        setTimeout(() => {
          self.options.catch(err);
        }, 0);
      }
      // 出错也认为是完成了
      self.runningTasksCount--;
      // 如果配置的出错重试次数大于任务已重试的次数, 则继续进入重试逻辑
      if (self.options.retry > task.retry) {
        // 重试次数增1
        task.retry++;
        // 如果重试任务优先, 则将任务置入队列头
        if (self.options.retryPrior) {
          self.queueTasks.unshift(task);
        } else {
          // 否则置入队列末尾
          self.queueTasks.push(task);
        }
        // 返回重试标识
        return retryFlag;
      } else {
        // 不重试就按套路返回
        return {
          err: err,
          res: null,
          putUntilRunTime: startTime - task.putTime,
          runTime: +new Date - startTime,
          retry: task.retry
        };
      }
    }).then(res => {
      // 每结束一个, 都要重新补充一个
      runTask(1);
      // 非加入重试的话, 走处理流程
      if (res !== retryFlag) {
        // 如果是批量添加的一组任务
        if (task.tag) {
          // 剩余未执行任务数减1
          self.taskTag[task.tag].remainingCount--;
          // 设置返回值
          self.taskTag[task.tag].results[task.index] = res;
          // 一组tag最后一个任务负责调用then
          if (self.taskTag[task.tag].remainingCount === 0) {
            let result = self.taskTag[task.tag].results;
            // 删除标签
            delete self.taskTag[task.tag];
            task.resolve(result);
          }
        } else {
          // 单个任务运行完直接then
          task.resolve(res);
        }
      }
    });
  }

  // 获取自增数, digits指定位数, 每个时间单位内允许有Math.pow(10, digits) - 1个并发不会有重复
  function getAndIncrement(digits = 7) {
    let r = (new Array(digits).fill(0).join('') + autoIncrement).slice(-1 * digits);
    if (autoIncrement == (Math.pow(10, digits) - 1)) {
      autoIncrement = 0;
    } else {
      autoIncrement++;
    }
    return r;
  }

  // 获取一组任务的唯一id
  // 每进程每秒10亿个并发id不重复
  function genId() {
    return +new Date + getAndIncrement();
  }

  // 超时拒绝
  function delayPromise(ms) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(timeoutFlag);
      }, ms);
    });
  }

  return {
    put,
    setOptions
  }

}

module.exports = QueueTask;