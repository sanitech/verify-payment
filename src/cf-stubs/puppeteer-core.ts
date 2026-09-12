const puppeteer = {
    launch: async () => {
        throw new Error("puppeteer-core is unavailable on Cloudflare Workers runtime");
    },
};

export default puppeteer;