const axios = require("axios");
const { tr } = require("zod/locales");

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const unsplashApi = axios.create({
  baseURL: process.env.UNSPLASH_BASE_URL,
  headers: {
    Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
    "Accept-Version": "v1",
  },
  timeout: 15000,
});
const DEFAULT_BACKGROUND = {
  url: "https://images.unsplash.com/photo-1615875605825-5eb9bb5d52ac?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4OTcyMTR8MHwxfHJhbmRvbXx8fHx8fHx8fDE3NzM2ODM1NDV8&ixlib=rb-4.1.0&q=80&w=1080",
  blur: "https://images.unsplash.com/photo-1615875605825-5eb9bb5d52ac?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4OTcyMTR8MHwxfHJhbmRvbXx8fHx8fHx8fDE3NzM2ODM1NDV8&ixlib=rb-4.1.0&q=80&w=200",
  credit: {
    name: "Unsplash",
    username: "unsplash",
    link: "https://unsplash.com",
  },
};

function mapPhoto(photo) {
  if (!photo) return null;

  return {
    id: photo.id,
    slug: photo.slug,
    description: photo.description,
    alt_description: photo.alt_description,
    width: photo.width,
    height: photo.height,
    color: photo.color,
    blur_hash: photo.blur_hash,
    urls: photo.urls,
    links: photo.links,
    likes: photo.likes,
    user: photo.user
      ? {
          name: photo.user.name,
          username: photo.user.username,
          profile_image: photo.user.profile_image,
          links: photo.user.links,
        }
      : null,
  };
}

async function searchPhotos(params = {}) {
  const {
    query,
    page = 1,
    per_page = 12,
    order_by = "relevant",
    orientation,
    color,
    content_filter = "high",
  } = params;

  if (!query) {
    throw httpError("Query is required", 400);
  }

  const response = await unsplashApi.get("/search/photos", {
    params: {
      query,
      page,
      per_page,
      order_by,
      orientation,
      color,
      content_filter,
    },
  });

  return {
    total: response.data.total,
    total_pages: response.data.total_pages,
    results: response.data.results.map(mapPhoto),
  };
}

async function getRandomPhotos(params = {}) {
  const { query, count = 8, orientation, content_filter = "high" } = params;

  const response = await unsplashApi.get("/photos/random", {
    params: {
      query,
      count,
      orientation,
      content_filter,
    },
  });

  const raw = Array.isArray(response.data) ? response.data : [response.data];

  return raw.map(mapPhoto);
}

async function getPhotoById(photoId) {
  if (!photoId) {
    throw httpError("Photo id is required", 400);
  }

  const response = await unsplashApi.get(`/photos/${photoId}`);
  return mapPhoto(response.data);
}

async function trackPhotoDownload(photoId) {
  if (!photoId) {
    throw httpError("Photo id is required", 400);
  }

  const response = await unsplashApi.get(`/photos/${photoId}/download`);

  return {
    url: response.data.url,
  };
}

async function backgroundPhoto() {
  try {
    const response = await unsplashApi.get("/photos/random", {
      params: {
        query: "interior design",
        orientation: "landscape",
        content_filter: "high",
      },
    });

    const photo = response.data;

    return {
      id: photo.id,
      url: photo.urls.regular,
      blur: photo.urls.thumb,
      credit: {
        name: photo.user.name,
        username: photo.user.username,
        link: photo.user.links.html,
      },
    };
  } catch (err) {
    return DEFAULT_BACKGROUND;
  }
}

module.exports = {
  searchPhotos,
  getRandomPhotos,
  getPhotoById,
  trackPhotoDownload,
  backgroundPhoto,
};
