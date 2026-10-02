import { request } from './request.js';

export function fetchState() {
  return request('/state');
}
export function fetchTeams() {
  return request('/teams');
}
