import { Link } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { YoutubeChannelPanel } from "@/components/youtube-channel-panel"
import {
  YOUTUBE_CHANNEL_SKINSPOTLIGHTS,
  YOUTUBE_CHANNEL_VANDIRIL,
  YOUTUBE_URL_SKINSPOTLIGHTS,
  YOUTUBE_URL_VANDIRIL,
} from "@/lib/youtube-channels"

export function CommunityPage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div className="mb-2">
        <Button type="button" variant="ghost" size="sm" className="gap-2 px-0" asChild>
          <Link to="/">
            <ArrowLeft className="h-4 w-4" />
            {t("settings.back")}
          </Link>
        </Button>
      </div>
      <div>
        <h2 className="text-xl font-semibold tracking-normal">{t("community.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("community.subtitle")}</p>
      </div>
      <Tabs defaultValue="vandiril" className="w-full">
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl bg-muted/25 p-1 sm:w-auto">
          <TabsTrigger value="vandiril" className="rounded-lg">
            {t("community.tabVandiril")}
          </TabsTrigger>
          <TabsTrigger value="skinspotlights" className="rounded-lg">
            {t("community.tabSkinSpotlights")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="vandiril" className="mt-4">
          <YoutubeChannelPanel
            channelId={YOUTUBE_CHANNEL_VANDIRIL}
            channelPageUrl={YOUTUBE_URL_VANDIRIL}
            heading={t("community.tabVandiril")}
          />
        </TabsContent>
        <TabsContent value="skinspotlights" className="mt-4">
          <YoutubeChannelPanel
            channelId={YOUTUBE_CHANNEL_SKINSPOTLIGHTS}
            channelPageUrl={YOUTUBE_URL_SKINSPOTLIGHTS}
            heading={t("community.tabSkinSpotlights")}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
