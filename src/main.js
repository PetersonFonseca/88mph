import './ui/style.css';
import {bootStreet} from './street/boot.js';

bootStreet().catch(error => {
  console.error(error);
  const message = document.createElement('div');
  message.className = 'fatal';
  message.textContent = `Os circuitos precisam de um ajuste. ${error.message}`;
  document.body.append(message);
});
